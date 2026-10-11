import {
  MessageBoxOptions,
  OpenDialogOptions,
  app,
  dialog,
  ipcMain,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { constants } from 'fs';
import fs from 'fs-extra';
import path from 'path';
import { SelectFileOptions, SelectFileReturn } from 'utils/types';
import databaseManager from '../backend/database/manager';
import { emitMainProcessError } from '../backend/helpers';
import { Main } from '../main';
import { DatabaseMethod } from '../utils/db/types';
import type { ExportFormat } from '../utils/ipc/types';
import config from '../utils/config';
import { DB_CREATE_CANCELLED_CODE, IPC_ACTIONS } from '../utils/messages';
import { getUrlAndTokenString, sendError } from './contactMothership';
import { getLanguageMap } from './getLanguageMap';
import { getTemplates } from './getPrintTemplates';
import { printHtmlDocument } from './printHtmlDocument';
import {
  displayFilePath,
  getConfigFilesWithModified,
  getErrorHandledReponse,
  isNetworkError,
  setAndGetCleanedConfigFiles,
} from './helpers';
import { saveHtmlAsPdf } from './saveHtmlAsPdf';
import { ExportPathAuthority } from './exportPathAuthority';
import { sendAPIRequest } from './api';
import { initScheduler } from './initSheduler';
import {
  DatabasePathAuthority,
  DatabaseOperation,
} from './databasePathAuthority';
import {
  assertDatabaseTarget,
  assertNoDatabaseSidecars,
  createDatabaseParent,
  resolveDatabasePath,
  verifyDatabaseFile,
} from '../backend/database/files';

export default function registerIpcMainActionListeners(main: Main) {
  const authority = new DatabasePathAuthority(main);
  const exports = new ExportPathAuthority(authority, () => [
    ...databaseManager.getProtectedDatabasePaths(),
    ...config.get('files', []).map((file) => file.dbPath),
  ]);
  let databaseOperationPending = false;
  async function databaseOperation(action: () => Promise<unknown>) {
    return getErrorHandledReponse(async () => {
      if (databaseOperationPending) {
        throw new Error('Another database filesystem operation is pending.');
      }
      databaseOperationPending = true;
      try {
        return await action();
      } finally {
        databaseOperationPending = false;
      }
    });
  }
  ipcMain.handle(IPC_ACTIONS.CHECK_DB_ACCESS, async (_, filePath: string) => {
    try {
      await fs.access(filePath, constants.W_OK | constants.R_OK);
    } catch (err) {
      return false;
    }

    return true;
  });

  ipcMain.handle(
    IPC_ACTIONS.GET_DB_DEFAULT_PATH,
    async (event, companyName: string) => {
      const window = authority.windowFor(event);
      if (
        typeof companyName !== 'string' ||
        !companyName.trim() ||
        companyName === '.' ||
        companyName === '..' ||
        /[<>:"/\\|?*\x00-\x1f]/.test(companyName) ||
        /[. ]$/.test(companyName) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(companyName)
      ) {
        throw new TypeError(
          'Company name must be a single valid filename component.'
        );
      }
      let root: string;
      try {
        root = app.getPath('documents');
      } catch {
        root = app.getPath('userData');
      }

      if (main.isDevelopment) {
        root = 'dbs';
      }

      const dbsPath = path.join(root, 'Frappe Books');

      let dbFilePath = path.join(dbsPath, `${companyName}.books.db`);

      if (await fs.pathExists(dbFilePath)) {
        const option = await dialog.showMessageBox(window, {
          type: 'question',
          title: 'File Exists',
          message: `Filename already exists. Do you want to overwrite the existing file or create a new one?`,
          detail: `Filesystem path: ${displayFilePath(dbFilePath)}`,
          buttons: ['Cancel', 'Overwrite', 'New'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });

        authority.assertWindow(event, window);
        if (option.response !== 1 && option.response !== 2) return '';
        if (option.response === 2) {
          const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '');

          dbFilePath = path.join(
            dbsPath,
            `${companyName}_${timestamp}.books.db`
          );

          await dialog.showMessageBox(window, {
            type: 'info',
            message: `New file: ${path.basename(dbFilePath)}`,
          });
        }
      }

      authority.assertWindow(event, window);
      return authority.grant(event, 'create', dbFilePath);
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.GET_OPEN_DATABASE_FILEPATH,
    async (
      event,
      operation: Exclude<DatabaseOperation, 'create'>,
      defaultPath?: string
    ) => {
      const window = authority.windowFor(event);
      if (operation !== 'connect' && operation !== 'delete') {
        throw new TypeError('Invalid database selection operation.');
      }
      if (defaultPath !== undefined) resolveDatabasePath(defaultPath);
      if (defaultPath && authority.has(operation, defaultPath)) {
        try {
          const target = await authority.get(event, operation, defaultPath);
          return { canceled: false, filePaths: [target.path] };
        } catch {
          authority.assertWindow(event, window);
        }
      }
      const result = await dialog.showOpenDialog(window, {
        title:
          operation === 'delete'
            ? 'Select database to delete'
            : 'Select database',
        defaultPath,
        properties: ['openFile', 'dontAddToRecent', 'noResolveAliases'],
      });
      authority.assertWindow(event, window);
      if (result.canceled || !result.filePaths[0]) {
        return { canceled: true, filePaths: [] };
      }
      const selectedPath = await authority.grant(
        event,
        operation,
        result.filePaths[0]
      );
      return { ...result, filePaths: [selectedPath] };
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.GET_SAVE_DATABASE_FILEPATH,
    async (event, defaultPath?: string) => {
      const window = authority.windowFor(event);
      if (defaultPath !== undefined) resolveDatabasePath(defaultPath);
      const result = await dialog.showSaveDialog(window, {
        title: 'Select database location',
        defaultPath,
      });
      authority.assertWindow(event, window);
      if (result.canceled || !result.filePath) {
        return { canceled: true, filePath: undefined };
      }
      const filePath = await authority.grant(event, 'create', result.filePath);
      return { ...result, filePath };
    }
  );

  ipcMain.handle(IPC_ACTIONS.GET_DB_RECOVERY_PATH, (event, dbPath: string) => {
    authority.windowFor(event);
    return databaseManager.getCachedRecoveryPath(resolveDatabasePath(dbPath));
  });

  ipcMain.handle(
    IPC_ACTIONS.GET_OPEN_FILEPATH,
    async (_, options: OpenDialogOptions) => {
      return await dialog.showOpenDialog(main.mainWindow!, options);
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.GET_SAVE_FILEPATH,
    async (event, name: string, format: ExportFormat) => {
      return exports.select(event, name, format);
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.GET_DIALOG_RESPONSE,
    async (_, options: MessageBoxOptions) => {
      if (main.isDevelopment || main.isLinux) {
        Object.assign(options, { icon: main.icon });
      }

      return await dialog.showMessageBox(main.mainWindow!, options);
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.SHOW_ERROR,
    (_, { title, content }: { title: string; content: string }) => {
      return dialog.showErrorBox(title, content);
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.SAVE_HTML_AS_PDF,
    async (
      event,
      html: string,
      savePath: string,
      width: number,
      height: number,
      grantId: string
    ) => {
      const grant = exports.consume(event, 'pdf', savePath, grantId);
      const data = await saveHtmlAsPdf(html, app, width, height);
      await exports.write(grant, data);
      return true;
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.PRINT_HTML_DOCUMENT,
    async (event, html: string, width: number, height: number) => {
      authority.windowFor(event);
      return await printHtmlDocument(html, app, width, height);
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.SAVE_DATA,
    async (event, data: string, savePath: string, grantId: string) => {
      const grant = exports.consume(event, 'text', savePath, grantId);
      if (typeof data !== 'string') throw new TypeError('Invalid export data.');
      await exports.write(grant, data);
    }
  );

  ipcMain.handle(IPC_ACTIONS.SEND_ERROR, async (_, bodyJson: string) => {
    await sendError(bodyJson, main);
  });

  ipcMain.handle(IPC_ACTIONS.CHECK_FOR_UPDATES, async () => {
    if (main.isDevelopment || main.checkedForUpdate) {
      return;
    }

    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      if (isNetworkError(error as Error)) {
        return;
      }

      emitMainProcessError(error);
    }
    main.checkedForUpdate = true;
  });

  ipcMain.handle(IPC_ACTIONS.GET_LANGUAGE_MAP, async (_, code: string) => {
    const obj = { languageMap: {}, success: true, message: '' };
    try {
      const match =
        typeof code === 'string'
          ? /^[a-z]{2}(?:-(?:[A-Z]{2}|[A-Z][a-z]{3}))?$/.exec(code)
          : null;
      if (!match || match[0] !== code) {
        throw new Error('Invalid language code.');
      }
      obj.languageMap = await getLanguageMap(code);
    } catch (err) {
      obj.success = false;
      obj.message = (err as Error).message;
    }

    return obj;
  });

  ipcMain.handle(
    IPC_ACTIONS.SELECT_FILE,
    async (_, options: SelectFileOptions): Promise<SelectFileReturn> => {
      const response: SelectFileReturn = {
        name: '',
        filePath: '',
        success: false,
        data: Buffer.from('', 'utf-8'),
        canceled: false,
      };
      const { filePaths, canceled } = await dialog.showOpenDialog(
        main.mainWindow!,
        { ...options, properties: ['openFile'] }
      );

      response.filePath = filePaths?.[0];
      response.canceled = canceled;

      if (!response.filePath) {
        return response;
      }

      response.success = true;
      if (canceled) {
        return response;
      }

      response.name = path.basename(response.filePath);
      response.data = await fs.readFile(response.filePath);
      return response;
    }
  );

  ipcMain.handle(IPC_ACTIONS.GET_CREDS, () => {
    return getUrlAndTokenString();
  });

  ipcMain.handle(IPC_ACTIONS.DELETE_FILE, async (event, filePath: string) => {
    return databaseOperation(async () => {
      const window = authority.windowFor(event);
      const target = await authority.get(event, 'delete', filePath, true);
      if (!(await confirmFileOperation(main, target.path, false))) {
        return;
      }
      authority.assertWindow(event, window);
      if (
        databaseManager.db?.dbPath === target.path &&
        databaseManager.db.knex
      ) {
        throw new Error('Close the database before deleting it.');
      }
      await assertNoDatabaseSidecars(target.path);
      await verifyDatabaseFile(target.path);
      await assertDatabaseTarget(target);
      authority.assertWindow(event, window);
      return await fs.unlink(target.path);
    });
  });

  ipcMain.handle(IPC_ACTIONS.GET_DB_LIST, async () => {
    const files = await setAndGetCleanedConfigFiles();
    return await getConfigFilesWithModified(files);
  });

  ipcMain.handle(IPC_ACTIONS.GET_ENV, async () => {
    let version = app.getVersion();
    if (main.isDevelopment) {
      const packageJson = await fs.readFile('package.json', 'utf-8');
      version = (JSON.parse(packageJson) as { version: string }).version;
    }

    return {
      isDevelopment: main.isDevelopment,
      platform: process.platform,
      version,
    };
  });

  ipcMain.handle(
    IPC_ACTIONS.GET_TEMPLATES,
    async (_, posPrintWidth?: number) => {
      return getTemplates(posPrintWidth);
    }
  );

  ipcMain.handle(IPC_ACTIONS.INIT_SHEDULER, async (_, interval: string) => {
    return initScheduler(interval);
  });

  ipcMain.handle(
    IPC_ACTIONS.SEND_API_REQUEST,
    async (e, endpoint: string, options: RequestInit | undefined) => {
      return sendAPIRequest(endpoint, options);
    }
  );

  /**
   * Database Related Actions
   */

  ipcMain.handle(
    IPC_ACTIONS.DB_CREATE,
    async (event, dbPath: string, countryCode: string) => {
      return await databaseOperation(async () => {
        const window = authority.windowFor(event);
        const targetPath =
          dbPath === ':memory:' ? dbPath : resolveDatabasePath(dbPath);
        let target =
          targetPath === ':memory:'
            ? undefined
            : await authority.get(event, 'create', targetPath, true);
        if (
          targetPath !== ':memory:' &&
          !(await confirmFileOperation(main, targetPath, true))
        ) {
          throw Object.assign(new Error('Database creation cancelled.'), {
            code: DB_CREATE_CANCELLED_CODE,
          });
        }
        authority.assertWindow(event, window);
        if (target) {
          await assertDatabaseTarget(target);
          target = await createDatabaseParent(target, () =>
            authority.assertWindow(event, window)
          );
        }
        authority.clearConnection();
        const result = await databaseManager.createNewDatabase(
          targetPath,
          countryCode,
          target,
          () => authority.assertWindow(event, window)
        );
        if (target) await authority.grant(event, 'connect', targetPath);
        authority.bindConnection(event, targetPath);
        return result;
      });
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.DB_CONNECT,
    async (event, dbPath: string, countryCode?: string) => {
      return await databaseOperation(async () => {
        const window = authority.windowFor(event);
        const targetPath =
          dbPath === ':memory:' ? dbPath : resolveDatabasePath(dbPath);
        const target =
          targetPath !== ':memory:'
            ? await authority.get(event, 'connect', targetPath, true)
            : undefined;
        authority.assertWindow(event, window);
        authority.clearConnection();
        const result = await databaseManager.connectToDatabase(
          targetPath,
          countryCode,
          () => authority.assertWindow(event, window),
          target
        );
        authority.assertWindow(event, window);
        if (targetPath !== ':memory:') {
          await authority.grant(event, 'connect', targetPath);
        }
        authority.bindConnection(event, targetPath);
        return result;
      });
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.DB_CALL,
    async (event, method: DatabaseMethod, ...args: unknown[]) => {
      return await getErrorHandledReponse(async () => {
        if (method === 'close') {
          authority.windowFor(event);
          const result = await databaseManager.call(method, ...args);
          authority.clearConnection();
          return result;
        }
        await authority.assertConnection(event);
        return await databaseManager.call(method, ...args);
      });
    }
  );

  ipcMain.handle(
    IPC_ACTIONS.DB_BESPOKE,
    async (event, method: string, ...args: unknown[]) => {
      return await getErrorHandledReponse(async () => {
        await authority.assertConnection(event);
        return await databaseManager.callBespoke(method, ...args);
      });
    }
  );

  ipcMain.handle(IPC_ACTIONS.DB_SCHEMA, async (event) => {
    return await getErrorHandledReponse(() => {
      authority.windowFor(event);
      return databaseManager.getSchemaMap();
    });
  });
}

async function confirmFileOperation(
  main: Main,
  targetPath: string,
  createDatabase: boolean
): Promise<boolean> {
  const window = main.mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error('No active window for filesystem confirmation.');
  }

  const displayPath = displayFilePath(targetPath);
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    title: createDatabase ? 'Create or replace database' : 'Delete database',
    message: createDatabase
      ? 'Create a database at this location? An existing database will be retained in a separate recovery file before replacement.'
      : 'Permanently delete the database file at this location?',
    detail: `Filesystem path: ${displayPath}`,
    buttons: ['Cancel', createDatabase ? 'Create' : 'Delete'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1 && main.mainWindow === window && !window.isDestroyed();
}
