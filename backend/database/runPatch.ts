import { emitMainProcessError, getDefaultMetaFieldValueMap } from '../helpers';
import { DatabaseManager } from './manager';
import { FieldValueMap, Patch } from './types';

export async function runPatches(
  patches: Patch[],
  dm: DatabaseManager,
  version: string
) {
  const list: { name: string; success: boolean }[] = [];
  for (const patch of patches) {
    const success = await runPatch(patch, dm, version);
    list.push({ name: patch.name, success });
  }
  return list;
}

async function runPatch(
  patch: Patch,
  dm: DatabaseManager,
  version: string
): Promise<boolean> {
  let failed = false;
  let primaryError: unknown;
  try {
    await patch.patch.execute(dm);
  } catch (error) {
    failed = true;
    primaryError = error;
    if (error instanceof Error) {
      error.message = `Patch Failed: ${patch.name}\n${error.message}`;
      emitMainProcessError(error, { patchName: patch.name, notifyUser: false });
    }
  }

  try {
    await makeEntry(patch, version, failed, dm);
  } catch (error) {
    if (!failed) throw error;
    if (primaryError instanceof Error) {
      const previous =
        (primaryError as Error & { cleanupErrors?: string[] }).cleanupErrors ??
        [];
      Object.assign(primaryError, {
        cleanupErrors: [...previous, String(error)],
      });
    }
  }
  if (failed) throw primaryError;
  return true;
}

async function makeEntry(
  patch: Patch,
  version: string,
  failed: boolean,
  dm: DatabaseManager
) {
  if (!dm.db?.knex)
    throw new Error('Cannot record PatchRun without an open database.');
  if (
    patch.patch.beforeMigrate &&
    !(await dm.db.knex.schema.hasTable('PatchRun'))
  )
    return;
  const outcome = { name: patch.name, failed, version };
  if (await dm.db.exists('PatchRun', patch.name)) {
    await dm.db.update('PatchRun', outcome);
  } else {
    await dm.db.insert('PatchRun', {
      ...(getDefaultMetaFieldValueMap() as FieldValueMap),
      ...outcome,
    });
  }
}
