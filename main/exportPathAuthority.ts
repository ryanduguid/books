import { randomUUID } from 'crypto';
import { dialog } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { Stats } from 'fs';
import fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import {
  assertDatabaseTarget,
  captureDatabaseTarget,
  DatabaseTarget,
  finishDatabaseCleanup,
  resolveDatabasePath,
} from '../backend/database/files';
import type { ExportFormat, ExportSelection } from '../utils/ipc/types';
import { DatabasePathAuthority } from './databasePathAuthority';
import { displayFilePath } from './helpers';

type Writer = 'text' | 'pdf';
interface ExportGrant {
  window: BrowserWindow;
  event: IpcMainInvokeEvent;
  target: DatabaseTarget;
  writer: Writer;
}

function sameIdentity(left: Stats, right: Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

export class ExportPathAuthority {
  private grants = new Map<string, ExportGrant>();
  private selection = 0;

  constructor(
    private owner: DatabasePathAuthority,
    private protectedPaths: () => string[]
  ) {}

  async select(
    event: IpcMainInvokeEvent,
    name: string,
    format: ExportFormat
  ): Promise<ExportSelection> {
    const window = this.owner.windowFor(event);
    const selection = ++this.selection;
    this.grants.clear();
    if (
      typeof name !== 'string' ||
      !['csv', 'json', 'template.html', 'pdf'].includes(format)
    ) {
      throw new TypeError('Invalid export format or filename.');
    }
    const result = await dialog.showSaveDialog(window, {
      title: 'Select export location',
      defaultPath: `${path.basename(name)}.${format}`,
    });
    this.assertSelection(event, window, selection);
    if (result.canceled || !result.filePath) return { canceled: true };
    const suffix = `.${format}`;
    const selectedPath = result.filePath.toLowerCase().endsWith(suffix)
      ? result.filePath
      : result.filePath + suffix;
    const target = await captureDatabaseTarget(selectedPath);
    if (path.dirname(target.path) !== target.ancestorRealPath) {
      throw new Error('Select an existing export folder.');
    }
    await this.assertProtected(target);
    this.assertSelection(event, window, selection);
    const confirmation = await dialog.showMessageBox(window, {
      type: 'question',
      title: target.entry ? 'Replace export file' : 'Save export file',
      message: target.entry ? 'Replace this file?' : 'Save to this file?',
      detail: displayFilePath(target.path),
      buttons: ['Cancel', target.entry ? 'Replace' : 'Save'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    this.assertSelection(event, window, selection);
    if (confirmation.response !== 1) return { canceled: true };
    await assertDatabaseTarget(target);
    await this.assertProtected(target);
    this.assertSelection(event, window, selection);
    const grantId = randomUUID();
    this.grants.set(grantId, {
      window,
      event,
      target,
      writer: format === 'pdf' ? 'pdf' : 'text',
    });
    return { canceled: false, filePath: target.path, grantId };
  }

  consume(
    event: IpcMainInvokeEvent,
    writer: Writer,
    filePath: string,
    grantId: string
  ) {
    const grant = this.grants.get(grantId);
    this.grants.delete(grantId);
    if (
      !grant ||
      grant.writer !== writer ||
      grant.target.path !== resolveDatabasePath(filePath) ||
      grant.event.sender !== event.sender ||
      grant.event.senderFrame !== event.senderFrame
    ) {
      throw new Error('Select an export destination before writing.');
    }
    this.owner.assertWindow(event, grant.window);
    return grant;
  }

  async write(grant: ExportGrant, data: string | Buffer) {
    await assertDatabaseTarget(grant.target);
    await this.assertProtected(grant.target);
    this.owner.assertWindow(grant.event, grant.window);
    const file = await fs.open(
      grant.target.path,
      grant.target.entry ? 'r+' : 'wx'
    );
    let created: Stats | undefined;
    let primaryError: unknown;
    try {
      const opened = await file.stat();
      if (grant.target.entry) {
        if (!sameIdentity(opened, grant.target.entry)) {
          throw new Error('Export file changed before writing.');
        }
        await this.assertHeader(file);
        await assertDatabaseTarget(grant.target);
      } else {
        created = opened;
        const current = await captureDatabaseTarget(grant.target.requestedPath);
        if (!current.entry || !sameIdentity(current.entry, opened)) {
          throw new Error('Export file changed during creation.');
        }
        await assertDatabaseTarget({ ...grant.target, entry: opened });
      }
      await this.assertProtected({ ...grant.target, entry: opened });
      this.owner.assertWindow(grant.event, grant.window);
      await file.writeFile(data);
      await file.truncate(Buffer.byteLength(data));
    } catch (error) {
      primaryError = error;
    }
    try {
      await file.close();
    } catch (error) {
      if (!primaryError) primaryError = error;
      else this.addCleanupError(primaryError, error);
    }
    if (primaryError && created) {
      try {
        const current = await captureDatabaseTarget(grant.target.requestedPath);
        if (!current.entry || !sameIdentity(current.entry, created)) {
          throw new Error('Export cleanup retained a changed file.');
        }
        await assertDatabaseTarget(current);
        await fs.unlink(current.path);
      } catch (error) {
        this.addCleanupError(primaryError, error);
      }
    }
    if (primaryError) throw primaryError;
  }

  private assertSelection(
    event: IpcMainInvokeEvent,
    window: BrowserWindow,
    selection: number
  ) {
    this.owner.assertWindow(event, window);
    if (selection !== this.selection) {
      throw new Error('A newer export selection replaced this request.');
    }
  }

  private async assertProtected(target: DatabaseTarget) {
    if (
      /(?:\.db|\.sqlite|\.sqlite3|\.books)(?:$|[.-])/i.test(
        path.basename(target.path)
      ) ||
      /-(?:wal|shm|journal)(?:$|\.)/i.test(path.basename(target.path)) ||
      target.path
        .split(path.sep)
        .some((part) => /^\..+\.recovery-/.test(part)) ||
      target.sidecars.some(Boolean)
    ) {
      throw new Error('An export cannot replace a database or recovery file.');
    }
    for (const protectedPath of this.protectedPaths()) {
      if (protectedPath === ':memory:') continue;
      if (resolveDatabasePath(protectedPath) === target.path) {
        throw new Error(
          'An export cannot replace a database or recovery file.'
        );
      }
      if (!target.entry) continue;
      try {
        if (sameIdentity(await fs.stat(protectedPath), target.entry)) {
          throw new Error(
            'An export cannot replace a database or recovery file.'
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (target.entry) {
      const file = await fs.open(target.path, 'r');
      let primaryError: unknown;
      try {
        if (!sameIdentity(await file.stat(), target.entry)) {
          throw new Error('Export file changed during validation.');
        }
        await this.assertHeader(file);
      } catch (error) {
        primaryError = error;
      }
      await finishDatabaseCleanup(primaryError, [() => file.close()]);
    }
  }

  private async assertHeader(file: FileHandle) {
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset < header.length) {
      const { bytesRead } = await file.read(
        header,
        offset,
        header.length - offset,
        offset
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (
      header.equals(Buffer.from('SQLite format 3\0')) ||
      header.readUInt32BE(0) === 0x377f0682 ||
      header.readUInt32BE(0) === 0x377f0683 ||
      header.subarray(0, 8).equals(Buffer.from('d9d505f920a163d7', 'hex'))
    ) {
      throw new Error('An export cannot replace SQLite data.');
    }
  }

  private addCleanupError(primary: unknown, cleanup: unknown) {
    if (primary instanceof Error) {
      const error = primary as Error & { cleanupErrors?: string[] };
      error.cleanupErrors = [...(error.cleanupErrors ?? []), String(cleanup)];
    }
  }
}
