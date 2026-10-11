import BetterSQLite3 from 'better-sqlite3';
import { Stats } from 'fs';
import fs from 'fs/promises';
import path from 'path';

export interface DatabaseTarget {
  requestedPath: string;
  path: string;
  ancestorPath: string;
  ancestorRealPath: string;
  ancestor: Stats;
  ancestorEntry: Stats;
  entry?: Stats;
  sidecars: (Stats | undefined)[];
}

const sidecarSuffixes = ['-wal', '-shm', '-journal'];

export function resolveDatabasePath(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) {
    throw new TypeError('Invalid database path.');
  }
  return path.resolve(value);
}

async function lstatIfPresent(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export async function captureDatabaseTarget(
  value: unknown
): Promise<DatabaseTarget> {
  const requestedPath = resolveDatabasePath(value);
  let ancestorPath = path.dirname(requestedPath);
  let ancestor = await lstatIfPresent(ancestorPath);
  while (!ancestor) {
    const parent = path.dirname(ancestorPath);
    if (parent === ancestorPath) {
      throw new Error('Database parent directory is unavailable.');
    }
    ancestorPath = parent;
    ancestor = await lstatIfPresent(ancestorPath);
  }
  const ancestorEntry = ancestor;
  const ancestorRealPath = await fs.realpath(ancestorPath);
  ancestor = await fs.stat(ancestorRealPath);
  if (!ancestor.isDirectory()) {
    throw new Error('Database parent is not a directory.');
  }
  const targetPath = path.join(
    ancestorRealPath,
    path.relative(ancestorPath, requestedPath)
  );
  const entry = await lstatIfPresent(targetPath);
  if (
    entry &&
    (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
  ) {
    throw new Error(
      'Select a regular database file with no filesystem aliases.'
    );
  }
  const sidecars = await Promise.all(
    sidecarSuffixes.map((suffix) => lstatIfPresent(targetPath + suffix))
  );
  if (
    sidecars.some(
      (entry) =>
        entry &&
        (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
    )
  ) {
    throw new Error('Database sidecars must be regular files without aliases.');
  }
  return {
    requestedPath,
    path: targetPath,
    ancestorPath,
    ancestorRealPath,
    ancestor,
    ancestorEntry,
    entry,
    sidecars,
  };
}

function sameIdentity(left?: Stats, right?: Stats) {
  return left === undefined || right === undefined
    ? left === right
    : left.dev === right.dev &&
        left.ino === right.ino &&
        left.birthtimeMs === right.birthtimeMs;
}

function sameEntry(left?: Stats, right?: Stats) {
  return (
    sameIdentity(left, right) &&
    left?.size === right?.size &&
    left?.mtimeMs === right?.mtimeMs &&
    left?.ctimeMs === right?.ctimeMs &&
    left?.nlink === right?.nlink
  );
}

async function assertDatabaseParent(target: DatabaseTarget) {
  const ancestorEntry = await fs.lstat(target.ancestorPath);
  const realPath = await fs.realpath(target.ancestorPath);
  const ancestor = await fs.stat(realPath);
  if (
    !sameIdentity(ancestorEntry, target.ancestorEntry) ||
    !sameIdentity(ancestor, target.ancestor) ||
    realPath !== target.ancestorRealPath
  ) {
    throw new Error('Database parent changed after selection.');
  }
}

export async function assertDatabaseTarget(
  target: DatabaseTarget,
  identityOnly = false,
  checkSidecarIdentity = !identityOnly
) {
  await assertDatabaseParent(target);
  const current = await captureDatabaseTarget(target.requestedPath);
  const compare = identityOnly ? sameIdentity : sameEntry;
  if (
    current.path !== target.path ||
    !compare(current.entry, target.entry) ||
    (checkSidecarIdentity &&
      current.sidecars.some(
        (entry, index) => !sameIdentity(entry, target.sidecars[index])
      )) ||
    (!identityOnly &&
      current.sidecars.some(
        (entry, index) => !sameEntry(entry, target.sidecars[index])
      ))
  ) {
    throw new Error('Database entry changed after selection.');
  }
  if (target.ancestorPath !== current.ancestorPath) {
    throw new Error('Database parent changed after selection.');
  }
}

export async function createDatabaseParent(
  target: DatabaseTarget,
  guard?: () => void
) {
  await assertDatabaseTarget(target);
  const relative = path.relative(
    target.ancestorRealPath,
    path.dirname(target.path)
  );
  let parent = target.ancestorRealPath;
  const createdParents: { path: string; identity: Stats }[] = [];
  async function checkParents() {
    await assertDatabaseParent(target);
    for (const created of createdParents) {
      const current = await fs.lstat(created.path);
      if (
        !current.isDirectory() ||
        !sameIdentity(current, created.identity) ||
        (await fs.realpath(created.path)) !== created.path
      ) {
        throw new Error('Database parent changed during directory creation.');
      }
    }
  }
  for (const component of relative.split(path.sep).filter(Boolean)) {
    await checkParents();
    parent = path.join(parent, component);
    guard?.();
    await fs.mkdir(parent);
    const identity = await fs.lstat(parent);
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new Error('Database parent changed during directory creation.');
    }
    createdParents.push({ path: parent, identity });
  }
  await checkParents();
  const current = await captureDatabaseTarget(target.path);
  if (
    current.path !== target.path ||
    !sameEntry(current.entry, target.entry) ||
    current.sidecars.some(
      (entry, index) => !sameEntry(entry, target.sidecars[index])
    ) ||
    !sameIdentity(await fs.lstat(target.ancestorPath), target.ancestorEntry) ||
    !sameIdentity(await fs.stat(target.ancestorRealPath), target.ancestor) ||
    (await fs.realpath(target.ancestorPath)) !== target.ancestorRealPath
  ) {
    throw new Error('Database target changed while creating its parent.');
  }
  return current;
}

export async function assertNoDatabaseSidecars(dbPath: string) {
  for (const suffix of sidecarSuffixes) {
    if (await lstatIfPresent(dbPath + suffix)) {
      throw new Error(
        'Close other database connections before replacing or deleting this file.'
      );
    }
  }
}

export async function finishDatabaseCleanup(
  primaryError: unknown,
  actions: (() => Promise<unknown> | unknown)[]
) {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (primaryError !== undefined) {
    if (errors.length && primaryError instanceof Error) {
      const previous =
        (primaryError as Error & { cleanupErrors?: string[] }).cleanupErrors ??
        [];
      Object.assign(primaryError, {
        cleanupErrors: [...previous, ...errors.map(String)],
      });
    }
    throw primaryError;
  }
  if (errors.length) {
    const [error, ...secondary] = errors;
    if (error instanceof Error && secondary.length) {
      Object.assign(error, { cleanupErrors: secondary.map(String) });
    }
    throw error;
  }
}

export async function removeOwnedDatabaseDirectory(
  directory: string,
  identity: Stats
) {
  if (
    !sameIdentity(await fs.lstat(directory), identity) ||
    identity.isSymbolicLink()
  ) {
    throw new Error('Database temporary directory changed.');
  }
  const names = await fs.readdir(directory);
  const allowed = [
    'database.db',
    ...sidecarSuffixes.map((suffix) => 'database.db' + suffix),
  ];
  const entries = await Promise.all(
    names.map((name) => fs.lstat(path.join(directory, name)))
  );
  if (
    names.some(
      (name, index) =>
        !allowed.includes(name) ||
        !entries[index].isFile() ||
        entries[index].isSymbolicLink() ||
        entries[index].nlink !== 1
    )
  ) {
    throw new Error(
      'Unexpected entry in database temporary directory; cleanup stopped.'
    );
  }
  for (const [index, name] of names.entries()) {
    const filePath = path.join(directory, name);
    if (!sameEntry(await fs.lstat(filePath), entries[index])) {
      throw new Error('Database temporary file changed; cleanup stopped.');
    }
    await fs.unlink(filePath);
  }
  await fs.rmdir(directory);
}

export async function backupDatabase(dbPath: string, prefix: string) {
  const parentPath = path.dirname(prefix);
  const parentIdentity = await fs.lstat(parentPath);
  const parentRealPath = await fs.realpath(parentPath);
  if (
    !parentIdentity.isDirectory() ||
    parentIdentity.isSymbolicLink() ||
    parentRealPath !== path.resolve(parentPath)
  ) {
    throw new Error('Database backup parent must be a canonical directory.');
  }
  const directory = await fs.mkdtemp(prefix);
  const identity = await fs.lstat(directory);
  const backupPath = path.join(directory, 'database.db');
  let driver: BetterSQLite3.Database | undefined;
  let verifier: BetterSQLite3.Database | undefined;
  let error: unknown;
  let verified = false;
  try {
    if (
      !sameIdentity(await fs.lstat(parentPath), parentIdentity) ||
      (await fs.realpath(parentPath)) !== parentRealPath ||
      (await fs.realpath(directory)) !==
        path.join(parentRealPath, path.basename(directory))
    ) {
      throw new Error('Database backup parent changed before the snapshot.');
    }
    driver = new BetterSQLite3(dbPath, { readonly: true, fileMustExist: true });
    await driver.backup(backupPath);
    verifier = new BetterSQLite3(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    const results = verifier.pragma('quick_check') as { quick_check: string }[];
    if (results.length !== 1 || results[0].quick_check !== 'ok') {
      throw new Error('Database recovery snapshot failed verification.');
    }
    verified = true;
  } catch (failure) {
    error = failure;
  }
  try {
    await finishDatabaseCleanup(error, [
      () => verifier?.close(),
      () => driver?.close(),
      async () => {
        if (!verified) await removeOwnedDatabaseDirectory(directory, identity);
      },
    ]);
  } catch (failure) {
    if (verified) addRecoveryToError(failure, backupPath);
    throw failure;
  }
  return backupPath;
}

export async function verifyDatabaseFile(dbPath: string) {
  let driver: BetterSQLite3.Database | undefined;
  let error: unknown;
  try {
    driver = new BetterSQLite3(dbPath, { readonly: true, fileMustExist: true });
    const results = driver.pragma('quick_check') as { quick_check: string }[];
    if (results.length !== 1 || results[0].quick_check !== 'ok') {
      throw new Error('Select a valid SQLite database file.');
    }
  } catch (failure) {
    error = failure;
  }
  await finishDatabaseCleanup(error, [() => driver?.close()]);
}

export function addRecoveryToError(error: unknown, recoveryPath?: string) {
  if (!recoveryPath || !(error instanceof Error)) return;
  const failure = error as Error & { recoveryPath?: string };
  if (failure.recoveryPath === recoveryPath) return;
  failure.recoveryPath = recoveryPath;
  const displayPath = JSON.stringify(recoveryPath).replace(
    /[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  failure.message += `\nOriginal database recovery file: ${displayPath}`;
}

export async function promoteDatabase(
  stagingPath: string,
  target: DatabaseTarget,
  guard?: () => void
) {
  const staged = await fs.lstat(stagingPath);
  if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1) {
    throw new Error('Database staging entry is not a regular owned file.');
  }
  await assertNoDatabaseSidecars(target.path);
  await assertDatabaseTarget(target);
  guard?.();
  // Node cannot atomically compare an existing entry's identity and rename over it.
  let promotedIdentity = staged;
  if (target.entry) {
    await fs.rename(stagingPath, target.path);
  } else {
    try {
      await fs.link(stagingPath, target.path);
    } catch (error) {
      if (
        !['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      ) {
        throw error;
      }
      promotedIdentity = await copyDatabaseExclusive(
        stagingPath,
        target.path,
        staged,
        guard
      );
    }
    await fs.unlink(stagingPath);
  }
  await assertDatabaseParent(target);
  const promoted = await captureDatabaseTarget(target.requestedPath);
  if (
    promoted.path !== target.path ||
    !sameIdentity(promoted.entry, promotedIdentity)
  ) {
    throw new Error('Promoted database entry changed before reconnect.');
  }
  guard?.();
  return promoted;
}

async function copyDatabaseExclusive(
  source: string,
  destination: string,
  staged: Stats,
  guard?: () => void
) {
  const input = await fs.open(source, 'r');
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  let identity: Stats | undefined;
  let error: unknown;
  try {
    if (!sameEntry(await input.stat(), staged)) {
      throw new Error('Database staging file changed before copying.');
    }
    guard?.();
    output = await fs.open(destination, 'wx');
    identity = await output.stat();
    guard?.();
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      guard?.();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      let offset = 0;
      while (offset < bytesRead) {
        guard?.();
        const { bytesWritten } = await output.write(
          buffer,
          offset,
          bytesRead - offset,
          null
        );
        if (!bytesWritten) throw new Error('Database copy made no progress.');
        offset += bytesWritten;
      }
    }
    if (!sameEntry(await input.stat(), staged)) {
      throw new Error('Database staging file changed while copying.');
    }
  } catch (failure) {
    error = failure;
  }
  await finishDatabaseCleanup(error, [
    () => output?.close(),
    () => input.close(),
    async () => {
      if (error === undefined || !identity) return;
      const current = await fs.lstat(destination);
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        !sameIdentity(current, identity)
      ) {
        throw new Error('Database copy destination changed; cleanup stopped.');
      }
      await fs.unlink(destination);
    },
  ]);
  return identity!;
}
