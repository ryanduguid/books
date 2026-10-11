import BetterSQLite3 from 'better-sqlite3';
import { realpathSync } from 'fs';
import fs from 'fs-extra';
import { DatabaseError } from 'fyo/utils/errors';
import path from 'path';
import { DatabaseDemuxBase, DatabaseMethod } from 'utils/db/types';
import { getMapFromList } from 'utils/index';
import { Version } from 'utils/version';
import { getSchemas } from '../../schemas';
import { databaseMethodSet } from '../helpers';
import patches from '../patches';
import { BespokeQueries } from './bespoke';
import DatabaseCore, { DatabaseOpenMode } from './core';
import { runPatches } from './runPatch';
import { BespokeFunction, Patch, RawCustomField } from './types';
import {
  addRecoveryToError,
  assertDatabaseTarget,
  backupDatabase,
  captureDatabaseTarget,
  DatabaseTarget,
  finishDatabaseCleanup,
  promoteDatabase,
  removeOwnedDatabaseDirectory,
} from './files';

export class DatabaseManager extends DatabaseDemuxBase {
  db?: DatabaseCore;
  rawCustomFields: RawCustomField[] = [];
  private recoveryPaths = new Map<string, string>();
  private operationGuard?: () => void;
  private operationTarget?: DatabaseTarget;
  private migrationRecoveryCreated = false;
  private isStaging = false;

  getRecoveryPath(dbPath: string) {
    const resolvedPath = path.resolve(dbPath);
    const recoveryPath = this.recoveryPaths.get(resolvedPath);
    if (recoveryPath !== undefined) return recoveryPath;
    try {
      return this.recoveryPaths.get(
        path.join(
          realpathSync(path.dirname(resolvedPath)),
          path.basename(resolvedPath)
        )
      );
    } catch {
      return recoveryPath;
    }
  }

  getProtectedDatabasePaths() {
    return [
      ...(this.db ? [this.db.dbPath] : []),
      ...this.recoveryPaths.keys(),
      ...this.recoveryPaths.values(),
    ];
  }

  validateDatabaseOperation() {
    this.operationGuard?.();
  }

  async checkDatabaseTarget() {
    this.validateDatabaseOperation();
    if (this.operationTarget)
      await assertDatabaseTarget(this.operationTarget, true);
    this.validateDatabaseOperation();
  }

  acceptPromotedTarget(target: DatabaseTarget) {
    if (this.operationTarget) this.operationTarget = target;
  }

  async retainRecovery(dbPath: string) {
    if (this.isStaging) return;
    await this.checkDatabaseTarget();
    const recoveryPath = await backupDatabase(
      dbPath,
      path.join(
        path.dirname(dbPath),
        `.${path.basename(dbPath).slice(0, 60)}.recovery-`
      )
    );
    this.recoveryPaths.set(path.resolve(dbPath), recoveryPath);
    await this.checkDatabaseTarget();
    return recoveryPath;
  }

  get #isInitialized(): boolean {
    return this.db !== undefined && this.db.knex !== undefined;
  }

  getSchemaMap() {
    if (this.#isInitialized) {
      return this.db?.schemaMap ?? getSchemas('-', this.rawCustomFields);
    }

    return getSchemas('-', this.rawCustomFields);
  }

  async createNewDatabase(
    dbPath: string,
    countryCode: string,
    selectedTarget?: DatabaseTarget,
    guard?: () => void
  ) {
    if (dbPath === ':memory:') {
      await this.db?.close();
      countryCode = await this._connect(dbPath, 'create', countryCode);
      await this.#migrate();
      return countryCode;
    }
    const target = selectedTarget ?? (await captureDatabaseTarget(dbPath));
    guard?.();
    await assertDatabaseTarget(target);
    await this.db?.close();
    this.db = undefined;
    await assertDatabaseTarget(target);
    const directory = await fs.mkdtemp(
      path.join(path.dirname(target.path), '.books-create-')
    );
    const identity = await fs.lstat(directory);
    const staged = new DatabaseManager();
    staged.isStaging = true;
    let error: unknown;
    let recoveryPath: string | undefined;
    let result = countryCode;
    try {
      result = await staged._connect(
        path.join(directory, 'database.db'),
        'create',
        countryCode
      );
      await staged.#migrate();
      await staged.db!.close();
      guard?.();
      await assertDatabaseTarget(target);
      if (target.entry) recoveryPath = await this.retainRecovery(target.path);
      guard?.();
      const promoted = await promoteDatabase(
        path.join(directory, 'database.db'),
        target,
        guard
      );
      await assertDatabaseTarget(promoted);
      guard?.();
      await this._connect(target.path, 'existing', result);
    } catch (failure) {
      error = failure;
      addRecoveryToError(error, recoveryPath);
    }
    try {
      await finishDatabaseCleanup(error, [
        () => staged.db?.close(),
        async () => {
          if (error !== undefined) {
            await this.db?.close();
            this.db = undefined;
          }
        },
        () => removeOwnedDatabaseDirectory(directory, identity),
      ]);
    } catch (failure) {
      addRecoveryToError(failure, recoveryPath);
      throw failure;
    }
    return result;
  }

  async connectToDatabase(
    dbPath: string,
    countryCode?: string,
    guard?: () => void,
    selectedTarget?: DatabaseTarget
  ) {
    this.operationGuard = guard;
    this.operationTarget = selectedTarget;
    this.migrationRecoveryCreated = false;
    try {
      guard?.();
      await this.db?.close();
      this.db = undefined;
      if (selectedTarget)
        await assertDatabaseTarget(selectedTarget, true, true);
      guard?.();
      countryCode = await this._connect(dbPath, 'existing', countryCode);
      await this.checkDatabaseTarget();
      await this.#migrate();
      return countryCode;
    } catch (error) {
      addRecoveryToError(error, this.getRecoveryPath(dbPath));
      await finishDatabaseCleanup(error, [() => this.db?.close()]);
      throw error;
    } finally {
      this.operationGuard = undefined;
      this.operationTarget = undefined;
    }
  }

  async _connect(
    dbPath: string,
    openMode: DatabaseOpenMode,
    countryCode?: string
  ) {
    if (dbPath !== ':memory:')
      dbPath = (await captureDatabaseTarget(dbPath)).path;
    countryCode ??= await DatabaseCore.getCountryCode(dbPath, openMode);
    this.db = new DatabaseCore(dbPath, openMode);
    try {
      await this.db.connect();
      await this.setRawCustomFields();
      const schemaMap = getSchemas(countryCode, this.rawCustomFields);
      this.db.setSchemaMap(schemaMap);
    } catch (error) {
      await finishDatabaseCleanup(error, [
        async () => {
          await this.db?.close();
          this.db = undefined;
        },
      ]);
      throw error;
    }
    return countryCode;
  }

  async setRawCustomFields() {
    try {
      this.rawCustomFields = (await this.db?.knex?.(
        'CustomField'
      )) as RawCustomField[];
    } catch {}
  }

  async #migrate(): Promise<void> {
    if (!this.#isInitialized) {
      return;
    }
    await this.checkDatabaseTarget();

    const isFirstRun = await this.#getIsFirstRun();
    if (isFirstRun) {
      for (const patch of patches) await patch.patch.preflight?.(this);
      await this.ensureMigrationRecovery();
      await this.db!.migrate();
    }

    await this.#executeMigration();
  }

  async #executeMigration() {
    await this.checkDatabaseTarget();
    const version = await this.#getAppVersion();
    const patches = await this.#getPatchesToExecute(version);

    const hasPatches = !!patches.pre.length || !!patches.post.length;
    if (hasPatches) {
      await this.#createBackup();
    }

    await runPatches(patches.pre, this, version);
    await this.checkDatabaseTarget();
    await this.db!.migrate({
      pre: async () => {
        if (hasPatches) {
          return;
        }

        await this.#createBackup();
      },
    });
    await runPatches(patches.post, this, version);
    await this.checkDatabaseTarget();
  }

  async #getPatchesToExecute(
    version: string
  ): Promise<{ pre: Patch[]; post: Patch[] }> {
    if (this.db === undefined) {
      return { pre: [], post: [] };
    }

    const query = (await this.db.knex!('PatchRun').select()) as {
      name: string;
      version?: string;
      failed?: boolean;
    }[];

    const runPatchesMap = getMapFromList(query, 'name');
    const unresolved = query.find(
      (run) => run.failed && run.version === version
    );
    if (unresolved) {
      const error = new DatabaseError(
        `Migration ${unresolved.name} failed for database version ${version}. Restore the retained recovery database or have this failure reviewed before reopening.`
      );
      addRecoveryToError(error, this.getRecoveryPath(this.db.dbPath));
      throw error;
    }
    /**
     * A patch is run only if:
     * - it hasn't run and was added in a future version
     *    i.e. app version is before patch added version
     * - it ran but failed in some other version (i.e fixed)
     */
    const filtered = patches
      .filter((p) => {
        const exec = runPatchesMap[p.name];
        if (!exec && Version.lte(version, p.version)) {
          return true;
        }

        if (exec?.failed && exec?.version !== version) {
          return true;
        }

        return false;
      })
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    return {
      pre: filtered.filter((p) => p.patch.beforeMigrate),
      post: filtered.filter((p) => !p.patch.beforeMigrate),
    };
  }

  async call(method: DatabaseMethod, ...args: unknown[]) {
    if (!this.#isInitialized) {
      return;
    }

    if (!databaseMethodSet.has(method)) {
      return;
    }

    // @ts-ignore
    const response = await this.db[method](...args);
    if (method === 'close') {
      delete this.db;
    }

    return response;
  }

  async callBespoke(method: string, ...args: unknown[]): Promise<unknown> {
    if (!this.#isInitialized) {
      return;
    }

    if (!BespokeQueries.hasOwnProperty(method)) {
      throw new DatabaseError(`invalid bespoke db function ${method}`);
    }

    const queryFunction: BespokeFunction =
      BespokeQueries[method as keyof BespokeFunction];
    return await queryFunction(this.db!, ...args);
  }

  async #getIsFirstRun(): Promise<boolean> {
    const knex = this.db?.knex;
    if (!knex) {
      return true;
    }

    const query = await knex('sqlite_master').where({
      type: 'table',
      name: 'PatchRun',
    });
    return !query.length;
  }

  async #createBackup() {
    const { dbPath } = this.db ?? {};
    if (!dbPath || dbPath === ':memory:' || this.isStaging) {
      return;
    }
    await this.ensureMigrationRecovery();
    if (process.env.IS_TEST) return;

    const backupPath = await this.#getBackupFilePath();
    if (!backupPath) {
      return;
    }

    await backupDatabase(dbPath, backupPath);
  }

  async ensureMigrationRecovery() {
    const dbPath = this.db?.dbPath;
    if (!dbPath || dbPath === ':memory:' || this.isStaging) return;
    this.validateDatabaseOperation();
    if (!this.migrationRecoveryCreated) {
      await this.retainRecovery(dbPath);
      this.migrationRecoveryCreated = true;
    }
  }

  async #getBackupFilePath() {
    const { dbPath } = this.db ?? {};
    if (dbPath === ':memory:' || !dbPath) {
      return null;
    }

    let fileName = path.parse(dbPath).name;
    if (fileName.endsWith('.books')) {
      fileName = fileName.slice(0, -6);
    }

    const backupFolder = path.join(path.dirname(dbPath), 'backups');
    const date = new Date().toISOString().split('T')[0];
    const version = await this.#getAppVersion();
    const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
    const backupFile = `${fileName.slice(0, 60)}_${safeVersion}_${date}-`;
    await fs.mkdir(backupFolder).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const folder = await fs.lstat(backupFolder);
    if (!folder.isDirectory() || folder.isSymbolicLink()) {
      throw new Error('Backup folder must be a regular directory.');
    }
    return path.join(backupFolder, backupFile);
  }

  async #getAppVersion(): Promise<string> {
    const knex = this.db?.knex;
    if (!knex) {
      return '0.0.0';
    }

    const query = await knex('SingleValue')
      .select('value')
      .where({ fieldname: 'version', parent: 'SystemSettings' });
    const value = (query[0] as undefined | { value: string })?.value;
    return value || '0.0.0';
  }

  getDriver() {
    const { dbPath } = this.db ?? {};
    if (!dbPath) {
      return null;
    }

    return BetterSQLite3(dbPath, { readonly: true, fileMustExist: true });
  }
}

export default new DatabaseManager();
