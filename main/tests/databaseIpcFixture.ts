import { constants, promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { loadSource } from './helpers';
import type { BackendResponse, ExportSelection } from '../../utils/ipc/types';

type DialogOptions = {
  buttons?: string[];
  detail?: string;
  defaultId?: number;
  cancelId?: number;
  [name: string]: unknown;
};
type OpenSelection = { canceled: boolean; filePaths: string[] };
type SaveSelection = { canceled: boolean; filePath?: string };

type Handler<Result> = (...args: unknown[]) => Result;
type AsyncHandler<Result> = Handler<Promise<Result>>;
type FixtureHandlers = {
  [Action in
    | 'db-create'
    | 'db-connect'
    | 'delete-file'
    | 'db-call'
    | 'db-bespoke']: AsyncHandler<BackendResponse>;
} & {
  'get-language-map': AsyncHandler<{
    languageMap: object;
    success: boolean;
    message: string;
  }>;
  'get-db-recovery-path': Handler<string | undefined>;
  'get-db-default-path': AsyncHandler<string>;
  'check-db-access': AsyncHandler<boolean>;
  'open-dialog': AsyncHandler<OpenSelection>;
  'open-database-dialog': AsyncHandler<OpenSelection>;
  'save-database-dialog': AsyncHandler<SaveSelection>;
  'save-dialog': AsyncHandler<ExportSelection>;
  'save-data': AsyncHandler<unknown>;
  'save-html-as-pdf': AsyncHandler<unknown>;
};

export const cancelledCode = 'ERR_DB_CREATE_CANCELLED';
const databaseActions = {
  create: 'db-create',
  connect: 'db-connect',
  delete: 'delete-file',
} as const;

function createCalls() {
  return {
    unlink: [] as string[],
    create: [] as unknown[][],
    connect: [] as unknown[][],
    dbCalls: [] as unknown[][],
    language: [] as string[],
    dialogs: [] as { parent: unknown; options: DialogOptions }[],
    selections: [] as { parent: unknown; options: unknown }[],
    directories: [] as string[],
    access: [] as { path: string; mode: number }[],
    targetLookups: [] as string[],
    pdf: 0,
  };
}

export function getHandlers(directory?: string, databaseManager?: object) {
  const handlers: Record<string, Handler<unknown>> = {};
  const calls = createCalls();
  let response = 0;
  let selectionCancelled = false;
  let selectedPath = '';
  let unlinkError: Error | undefined;
  let onDialog: () => Promise<void> | void = () => undefined;
  let onAccess: () => Promise<void> | void = () => undefined;
  const frame = {};
  const sender = { isDestroyed: () => false, mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: sender };
  const main = { mainWindow: window };
  const event = { sender, senderFrame: frame };
  const messages =
    loadSource<typeof import('../../utils/messages')>('utils/messages.ts');
  const helpers = loadSource<typeof import('../helpers')>('main/helpers.ts');
  function bounded(value: string) {
    if (!directory)
      throw new Error('Filesystem operation has no test fixture.');
    const relative = path.relative(directory, value);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
      throw new Error('Filesystem operation escaped the test fixture.');
    }
  }
  const files = loadSource<typeof import('../../backend/database/files')>(
    'backend/database/files.ts',
    {
      'fs/promises': {
        ...fs,
        lstat: async (value: string) => {
          bounded(value);
          calls.targetLookups.push(value);
          return fs.lstat(value);
        },
        stat: async (value: string) => {
          bounded(value);
          calls.targetLookups.push(value);
          return fs.stat(value);
        },
        realpath: async (value: string) => {
          bounded(value);
          calls.targetLookups.push(value);
          return fs.realpath(value);
        },
        mkdir: async (value: string) => {
          bounded(value);
          calls.directories.push(value);
          await fs.mkdir(value);
        },
      },
      path,
      'better-sqlite3': class {
        pragma() {
          return [{ quick_check: 'ok' }];
        }
        close() {
          return;
        }
      },
    }
  );
  const authority = loadSource<typeof import('../databasePathAuthority')>(
    'main/databasePathAuthority.ts',
    {
      '../backend/database/files': files,
    }
  );
  const listener = loadSource<{ default: (appMain: typeof main) => void }>(
    'main/registerIpcMainActionListeners.ts',
    {
      fs: { constants },
      electron: {
        app: { getPath: () => directory ?? 'documents' },
        ipcMain: {
          handle: (name: string, handler: Handler<unknown>) => {
            handlers[name] = handler;
          },
        },
        dialog: {
          showMessageBox: async (parent: unknown, options: DialogOptions) => {
            calls.dialogs.push({ parent, options });
            await onDialog();
            return { response };
          },
          showOpenDialog: async (parent: unknown, options: unknown) => {
            calls.selections.push({ parent, options });
            await onDialog();
            return {
              canceled: selectionCancelled,
              filePaths: selectedPath ? [selectedPath] : [],
            };
          },
          showSaveDialog: async (parent: unknown, options: unknown) => {
            calls.selections.push({ parent, options });
            await onDialog();
            return {
              canceled: selectionCancelled,
              filePath: selectedPath || undefined,
            };
          },
        },
      },
      'fs-extra': {
        access: async (value: string, mode: number) => {
          bounded(value);
          calls.access.push({ path: value, mode });
          await onAccess();
          await fs.access(value, mode);
        },
        pathExists: async (value: string) =>
          fs
            .access(value)
            .then(() => true)
            .catch(() => false),
        unlink: async (value: string) => {
          bounded(value);
          calls.unlink.push(value);
          if (unlinkError) throw unlinkError;
          await fs.unlink(value);
        },
      },
      path,
      '../utils/messages': messages,
      './helpers': helpers,
      './saveHtmlAsPdf': {
        saveHtmlAsPdf: () => {
          calls.pdf++;
          return Promise.resolve(Buffer.from('pdf fixture'));
        },
      },
      './databasePathAuthority': authority,
      './exportPathAuthority': loadSource<
        typeof import('../exportPathAuthority')
      >('main/exportPathAuthority.ts', {
        'fs/promises': fs,
        path,
        crypto: { randomUUID },
        '../backend/database/files': files,
        './helpers': helpers,
        electron: {
          dialog: {
            showSaveDialog: async (parent: unknown, options: unknown) => {
              calls.selections.push({ parent, options });
              await onDialog();
              return {
                canceled: selectionCancelled,
                filePath: selectedPath || undefined,
              };
            },
            showMessageBox: async (parent: unknown, options: DialogOptions) => {
              calls.dialogs.push({ parent, options });
              await onDialog();
              return { response };
            },
          },
        },
      }),
      '../utils/config': { get: () => [] },
      '../backend/database/files': files,
      '../backend/database/manager': databaseManager ?? {
        getProtectedDatabasePaths: () => [],
        createNewDatabase: async (
          ...args: [string, string, unknown?, (() => void)?]
        ) => {
          calls.create.push(args);
          args[3]?.();
          if (args[0] !== ':memory:') {
            bounded(args[0]);
            await fs.writeFile(args[0], 'synthetic database');
          }
          return args[1];
        },
        connectToDatabase: async (
          ...args: [string, string?, (() => void)?]
        ) => {
          calls.connect.push(args);
          args[2]?.();
          return Promise.resolve(args[1] ?? 'au');
        },
        call: async (...args: unknown[]) => {
          calls.dbCalls.push(args);
          return Promise.resolve('synthetic result');
        },
        callBespoke: async (...args: unknown[]) => {
          calls.dbCalls.push(args);
          return Promise.resolve('synthetic result');
        },
      },
      './getLanguageMap': {
        getLanguageMap: async (code: string) => {
          calls.language.push(code);
          return Promise.resolve({ hello: code });
        },
      },
    }
  );
  listener.default(main);
  const registered = handlers as FixtureHandlers;
  function grant(operation: 'create', value: string): Promise<SaveSelection>;
  function grant(
    operation: 'connect' | 'delete',
    value: string
  ): Promise<OpenSelection>;
  function grant(
    operation: keyof typeof databaseActions,
    value: string
  ): Promise<SaveSelection | OpenSelection>;
  async function grant(operation: keyof typeof databaseActions, value: string) {
    selectedPath = value;
    selectionCancelled = false;
    if (operation === 'create')
      return registered['save-database-dialog'](event);
    return registered['open-database-dialog'](event, operation);
  }
  return {
    handlers: registered,
    calls,
    main,
    window,
    event,
    invoke: (
      operation: keyof typeof databaseActions,
      target: string,
      country = 'au'
    ) => registered[databaseActions[operation]](event, target, country),
    approve: () => {
      response = 1;
    },
    rejectWith: (value: number) => {
      response = value;
    },
    failUnlink: (error: Error) => {
      unlinkError = error;
    },
    duringDialog: (callback: () => Promise<void> | void) => {
      onDialog = callback;
    },
    duringAccess: (callback: () => Promise<void> | void) => {
      onAccess = callback;
    },
    select: (value: string, cancelled = false) => {
      selectedPath = value;
      selectionCancelled = cancelled;
    },
    grant,
  };
}

export async function withFixture(run: (directory: string) => Promise<void>) {
  const temporaryRoot = await fs.realpath(tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'books-ipc-'));
  let failure: { error: unknown } | undefined;
  try {
    await run(directory);
  } catch (error) {
    failure = { error };
  }

  try {
    const resolved = await fs.realpath(directory);
    if (
      resolved !== path.resolve(directory) ||
      path.dirname(resolved) !== temporaryRoot ||
      !path.basename(directory).startsWith('books-ipc-')
    ) {
      throw new Error('Unexpected fixture cleanup path.');
    }
    await fs.rm(directory, { recursive: true, force: true });
  } catch (error) {
    if (failure) {
      throw new AggregateError(
        [failure.error, error],
        'Fixture execution and cleanup both failed.'
      );
    }
    throw error;
  }

  if (failure) throw failure.error;
}
