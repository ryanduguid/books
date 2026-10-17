import { Fyo, t } from 'fyo';

type Conn = {
  countryCode: string;
  error?: Error;
  actionSymbol?: typeof dbErrorActionSymbols[keyof typeof dbErrorActionSymbols];
};

export const dbErrorActionSymbols = {
  SelectFile: Symbol('select-file'),
  CancelSelection: Symbol('cancel-selection'),
} as const;

export async function addDatabaseRecoveryToError(
  error: unknown,
  dbPath: string
) {
  if (!(error instanceof Error)) return;
  try {
    const recoveryPath = await ipc.getDbRecoveryPath(dbPath);
    if (!recoveryPath) return;
    const displayPath = JSON.stringify(recoveryPath).replace(
      /[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
    );
    if (error.message.includes(displayPath)) return;
    Object.assign(error, { recoveryPath });
    error.message += `\nOriginal database recovery file: ${displayPath}`;
  } catch {}
}

export async function showDatabaseError(error: unknown, dbPath?: string) {
  if (dbPath) await addDatabaseRecoveryToError(error, dbPath);
  await ipc.showError(
    t`Database operation failed`,
    error instanceof Error ? error.message : String(error)
  );
}

const dbErrors = {
  DirectoryDoesNotExist: 'directory does not exist',
  UnableToAcquireConnection: 'Unable to acquire a connection',
} as const;

export async function connectToDatabase(
  fyo: Fyo,
  dbPath: string,
  countryCode?: string
): Promise<Conn> {
  try {
    return { countryCode: await fyo.db.connectToDatabase(dbPath, countryCode) };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return {
      countryCode: '',
      error,
      actionSymbol: await handleDatabaseConnectionError(error, dbPath),
    };
  }
}

export async function handleDatabaseConnectionError(
  error: Error,
  dbPath: string
) {
  const message = error.message;
  if (typeof message !== 'string') {
    throw error;
  }

  if (message.includes(dbErrors.DirectoryDoesNotExist)) {
    return await handleDirectoryDoesNotExist(dbPath);
  }

  if (message.includes(dbErrors.UnableToAcquireConnection)) {
    return await handleUnableToAcquireConnection(dbPath);
  }

  throw error;
}

async function handleUnableToAcquireConnection(dbPath: string) {
  return await showDbErrorDialog(
    t`Could not connect to database file ${dbPath}, please select the file manually`
  );
}

async function handleDirectoryDoesNotExist(dbPath: string) {
  return await showDbErrorDialog(
    t`Directory for database file ${dbPath} does not exist, please select the file manually`
  );
}

async function showDbErrorDialog(detail: string) {
  const { showDialog } = await import('src/utils/interactive');
  return showDialog({
    type: 'error',
    title: t`Cannot Open File`,
    detail,
    buttons: [
      {
        label: t`Select File`,
        action() {
          return dbErrorActionSymbols.SelectFile;
        },
        isPrimary: true,
      },
      {
        label: t`Cancel`,
        action() {
          return dbErrorActionSymbols.CancelSelection;
        },
        isEscape: true,
      },
    ],
  }) as Promise<typeof dbErrorActionSymbols[keyof typeof dbErrorActionSymbols]>;
}
