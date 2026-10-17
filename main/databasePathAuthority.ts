import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from 'electron';
import type { Main } from '../main';
import {
  assertDatabaseTarget,
  captureDatabaseTarget,
  DatabaseTarget,
  resolveDatabasePath,
} from '../backend/database/files';

export type DatabaseOperation = 'create' | 'connect' | 'delete';

interface DatabaseOwner {
  window: BrowserWindow;
  sender: WebContents;
  frame: WebFrameMain;
}

interface DatabaseGrant extends DatabaseOwner {
  operation: DatabaseOperation;
  target: DatabaseTarget;
}

export class DatabasePathAuthority {
  private grants = new Map<string, DatabaseGrant>();
  private connection?: DatabaseOwner & { target?: DatabaseTarget };

  constructor(private main: Main) {}

  windowFor(event: IpcMainInvokeEvent) {
    const window = this.main.mainWindow;
    if (
      !window ||
      window.isDestroyed() ||
      !event?.sender ||
      event.sender !== window.webContents ||
      event.sender.isDestroyed() ||
      !event.senderFrame ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error(
        'Database operation requires the active main window sender.'
      );
    }
    return window;
  }

  assertWindow(event: IpcMainInvokeEvent, window: BrowserWindow) {
    if (this.windowFor(event) !== window) {
      throw new Error('Database window changed after selection.');
    }
  }

  async grant(
    event: IpcMainInvokeEvent,
    operation: DatabaseOperation,
    value: string
  ) {
    const window = this.windowFor(event);
    const target = await captureDatabaseTarget(value);
    if (operation !== 'create' && !target.entry) {
      throw new Error('Select an existing database file.');
    }
    this.assertWindow(event, window);
    this.grants.set(this.key(operation, target.path), {
      window,
      sender: event.sender,
      frame: event.senderFrame,
      operation,
      target,
    });
    return target.path;
  }

  async get(
    event: IpcMainInvokeEvent,
    operation: DatabaseOperation,
    value: string,
    consume = false
  ) {
    const window = this.windowFor(event);
    const targetPath = resolveDatabasePath(value);
    const key = this.key(operation, targetPath);
    const grant = this.grants.get(key);
    if (!grant) {
      throw new Error(
        'Database path has no authority for this operation. Select it using the database dialog.'
      );
    }
    if (
      grant.window !== window ||
      grant.sender !== event.sender ||
      grant.frame !== event.senderFrame ||
      grant.operation !== operation
    ) {
      this.grants.delete(key);
      throw new Error(
        'Database authority belongs to a different window or sender.'
      );
    }
    if (consume) this.grants.delete(key);
    try {
      await assertDatabaseTarget(grant.target, operation === 'connect', true);
    } catch (error) {
      this.grants.delete(key);
      throw error;
    }
    this.assertWindow(event, window);
    return grant.target;
  }

  has(operation: DatabaseOperation, value: string) {
    return this.grants.has(this.key(operation, resolveDatabasePath(value)));
  }

  bindConnection(event: IpcMainInvokeEvent, value: string) {
    const window = this.windowFor(event);
    const grant =
      value === ':memory:'
        ? undefined
        : this.grants.get(this.key('connect', resolveDatabasePath(value)));
    if (value !== ':memory:' && !grant) {
      throw new Error('Database connection has no path authority.');
    }
    this.connection = {
      window,
      sender: event.sender,
      frame: event.senderFrame,
      target: grant?.target,
    };
  }

  clearConnection() {
    this.connection = undefined;
  }

  async assertConnection(event: IpcMainInvokeEvent) {
    const window = this.windowFor(event);
    const connection = this.connection;
    if (
      !connection ||
      connection.window !== window ||
      connection.sender !== event.sender ||
      connection.frame !== event.senderFrame
    ) {
      throw new Error(
        'Database connection belongs to a different window or sender.'
      );
    }
    if (connection.target) {
      await assertDatabaseTarget(connection.target, true);
    }
    this.assertWindow(event, window);
    if (this.connection !== connection) {
      throw new Error('Database connection changed before the operation.');
    }
  }

  private key(operation: DatabaseOperation, targetPath: string) {
    return `${operation}:${targetPath}`;
  }
}
