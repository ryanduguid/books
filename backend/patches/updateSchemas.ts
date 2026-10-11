import fs from 'fs/promises';
import { RawValueMap } from 'fyo/core/types';
import { Knex } from 'knex';
import path from 'path';
import { changeKeys, deleteKeys, getIsNullOrUndef } from 'utils';
import { getCountryCodeFromCountry } from 'utils/misc';
import { Version } from 'utils/version';
import { ModelNameEnum } from '../../models/types';
import { FieldTypeEnum, Schema, SchemaMap } from '../../schemas/types';
import { DatabaseManager } from '../database/manager';
import {
  addRecoveryToError,
  assertDatabaseTarget,
  captureDatabaseTarget,
  DatabaseTarget,
  finishDatabaseCleanup,
  promoteDatabase,
  removeOwnedDatabaseDirectory,
} from '../database/files';

const ignoreColumns = ['keywords'];
const columnMap = { creation: 'created', owner: 'createdBy' };
const childTableColumnMap = {
  parenttype: 'parentSchemaName',
  parentfield: 'parentFieldname',
};

const defaultNumberSeriesMap = {
  [ModelNameEnum.Payment]: 'PAY-',
  [ModelNameEnum.JournalEntry]: 'JV-',
  [ModelNameEnum.SalesInvoice]: 'SINV-',
  [ModelNameEnum.PurchaseInvoice]: 'PINV-',
  [ModelNameEnum.SalesQuote]: 'SQUOT-',
} as Record<ModelNameEnum, string>;

async function execute(dm: DatabaseManager) {
  if (dm.db?.dbPath === ':memory:') {
    return;
  }

  const sourceKnex = dm.db!.knex!;
  const version = (
    (await sourceKnex('SingleValue')
      .select('value')
      .where({ fieldname: 'version', parent: 'SystemSettings' })) as {
      value: string;
    }[]
  )?.[0]?.value;

  /**
   * Versions after this should have the new schemas
   */

  if (version && Version.gt(version, '0.4.3-beta.0')) {
    return;
  }
  await preflight(dm);

  /**
   * Initialize a different db to copy all the updated
   * data into.
   */
  const countryCode = await getCountryCode(sourceKnex);
  const sourceTarget = await captureDatabaseTarget(dm.db!.dbPath);
  await dm.checkDatabaseTarget();
  const temporaryDirectory = await fs.mkdtemp(
    path.join(path.dirname(dm.db!.dbPath), '__update_schemas-')
  );
  const destDm = new DatabaseManager();
  const temporaryIdentity = await fs.lstat(temporaryDirectory);
  let primaryError: unknown;

  /**
   * Copy data from all the relevant tables
   * the other tables will be empty cause unused.
   */
  try {
    await destDm._connect(
      path.join(temporaryDirectory, 'database.db'),
      'create',
      countryCode
    );
    await destDm.db!.migrate();
    await destDm.db!.truncate();
    await copyData(sourceKnex, destDm);

    /**
     * Version will update when migration completes, this
     * is set to prevent this patch from running again.
     */
    await destDm.db!.update(ModelNameEnum.SystemSettings, {
      version: '0.5.0-beta.0',
    });

    /**
     * Replace the database with the new one.
     */
    await assertDatabaseTarget(sourceTarget);
    await replaceDatabaseCore(dm, destDm, sourceTarget);
  } catch (error) {
    primaryError = error;
    addRecoveryToError(error, dm.getRecoveryPath(sourceTarget.path));
  }
  try {
    await finishDatabaseCleanup(primaryError, [
      () => destDm.db?.close(),
      () => removeOwnedDatabaseDirectory(temporaryDirectory, temporaryIdentity),
    ]);
  } catch (error) {
    addRecoveryToError(error, dm.getRecoveryPath(sourceTarget.path));
    throw error;
  }
}

async function replaceDatabaseCore(
  dm: DatabaseManager,
  destDm: DatabaseManager,
  sourceTarget: DatabaseTarget
) {
  const newDbPath = destDm.db!.dbPath; // new db with new schema
  const oldDbPath = dm.db!.dbPath; // old db to be replaced

  await dm.db!.close();
  await destDm.db!.close();
  dm.validateDatabaseOperation();
  await assertDatabaseTarget(sourceTarget, true);
  await dm.checkDatabaseTarget();
  const target = await captureDatabaseTarget(oldDbPath);
  await dm.ensureMigrationRecovery();
  const promoted = await promoteDatabase(newDbPath, target, () =>
    dm.validateDatabaseOperation()
  );
  dm.acceptPromotedTarget(promoted);
  await dm.checkDatabaseTarget();
  await dm._connect(oldDbPath, 'existing');
}

async function copyData(sourceKnex: Knex, destDm: DatabaseManager) {
  const destKnex = destDm.db!.knex!;
  const schemaMap = destDm.getSchemaMap();
  await destKnex.raw('PRAGMA foreign_keys=OFF');
  await copySingleValues(sourceKnex, destKnex, schemaMap);
  await copyParty(sourceKnex, destKnex, schemaMap[ModelNameEnum.Party]!);
  await copyItem(sourceKnex, destKnex, schemaMap[ModelNameEnum.Item]!);
  await copyChildTables(sourceKnex, destKnex, schemaMap);
  await copyOtherTables(sourceKnex, destKnex, schemaMap);
  await copyTransactionalTables(sourceKnex, destKnex, schemaMap);
  await copyLedgerEntries(
    sourceKnex,
    destKnex,
    schemaMap[ModelNameEnum.AccountingLedgerEntry]!
  );
  await copyNumberSeries(
    sourceKnex,
    destKnex,
    schemaMap[ModelNameEnum.NumberSeries]!
  );
  await destKnex.raw('PRAGMA foreign_keys=ON');
}

async function copyNumberSeries(
  sourceKnex: Knex,
  destKnex: Knex,
  schema: Schema
) {
  const values = (await sourceKnex(
    ModelNameEnum.NumberSeries
  )) as RawValueMap[];
  validateNumberSeries(values, schema);

  await copyValues(
    destKnex,
    ModelNameEnum.NumberSeries,
    values,
    [],
    {},
    schema
  );
  const copied = (await destKnex(ModelNameEnum.NumberSeries)) as RawValueMap[];
  const fields = ['name', 'referenceType', 'start', 'current', 'padZeros'];
  if (
    copied.length !== values.length ||
    values.some((value) => {
      const match = copied.find((row) => row.name === value.name);
      return !match || fields.some((field) => match[field] !== value[field]);
    })
  ) {
    throw new Error('Number series changed during migration.');
  }
}

async function preflight(dm: DatabaseManager) {
  if (dm.db?.dbPath === ':memory:') return;
  const knex = dm.db!.knex!;
  if (!(await knex.schema.hasTable('SingleValue'))) return;
  const version = (await knex('SingleValue')
    .where({ fieldname: 'version', parent: 'SystemSettings' })
    .first()) as { value?: string } | undefined;
  if (version?.value && Version.gt(version.value, '0.4.3-beta.0')) return;
  if (!(await knex.schema.hasTable(ModelNameEnum.NumberSeries))) return;
  const values = (await knex(ModelNameEnum.NumberSeries)) as RawValueMap[];
  validateNumberSeries(values, dm.getSchemaMap()[ModelNameEnum.NumberSeries]!);
}

function validateNumberSeries(values: RawValueMap[], schema: Schema) {
  const field = schema.fields.find(
    (field) => field.fieldname === 'referenceType'
  );
  const supported = (field && 'options' in field ? field.options : []).map(
    (option) => option.value
  );
  const names = new Set<string>();
  for (const value of values) {
    if (
      typeof value.name !== 'string' ||
      !value.name ||
      names.has(value.name) ||
      typeof value.referenceType !== 'string' ||
      !supported.includes(value.referenceType) ||
      ['start', 'current', 'padZeros'].some(
        (key) => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0
      )
    ) {
      throw new Error(
        `Number series ${String(
          value.name
        )} cannot be migrated safely. Its reference type or counter settings require review. The source database is retained.`
      );
    }
    names.add(value.name);
  }
}

async function copyLedgerEntries(
  sourceKnex: Knex,
  destKnex: Knex,
  schema: Schema
) {
  const values = (await sourceKnex(
    ModelNameEnum.AccountingLedgerEntry
  )) as RawValueMap[];
  await copyValues(
    destKnex,
    ModelNameEnum.AccountingLedgerEntry,
    values,
    ['description', 'againstAccount', 'balance'],
    {},
    schema
  );
}

async function copyOtherTables(
  sourceKnex: Knex,
  destKnex: Knex,
  schemaMap: SchemaMap
) {
  const schemaNames = [
    ModelNameEnum.Account,
    ModelNameEnum.Currency,
    ModelNameEnum.Address,
    ModelNameEnum.Color,
    ModelNameEnum.Tax,
    ModelNameEnum.PatchRun,
  ];

  for (const sn of schemaNames) {
    const values = (await sourceKnex(sn)) as RawValueMap[];
    await copyValues(destKnex, sn, values, [], {}, schemaMap[sn]);
  }
}

async function copyTransactionalTables(
  sourceKnex: Knex,
  destKnex: Knex,
  schemaMap: SchemaMap
) {
  const schemaNames = [
    ModelNameEnum.JournalEntry,
    ModelNameEnum.Payment,
    ModelNameEnum.SalesInvoice,
    ModelNameEnum.PurchaseInvoice,
    ModelNameEnum.SalesQuote,
  ];

  for (const sn of schemaNames) {
    const values = (await sourceKnex(sn)) as RawValueMap[];
    values.forEach((v) => {
      if (!v.submitted) {
        v.submitted = 0;
      }

      if (!v.cancelled) {
        v.cancelled = 0;
      }

      if (!v.numberSeries) {
        v.numberSeries = defaultNumberSeriesMap[sn];
      }

      if (v.customer) {
        v.party = v.customer;
      }

      if (v.supplier) {
        v.party = v.supplier;
      }
    });
    await copyValues(
      destKnex,
      sn,
      values,
      [],
      childTableColumnMap,
      schemaMap[sn]
    );
  }
}

async function copyChildTables(
  sourceKnex: Knex,
  destKnex: Knex,
  schemaMap: SchemaMap
) {
  const childSchemaNames = Object.keys(schemaMap).filter(
    (sn) => schemaMap[sn]?.isChild
  );

  for (const sn of childSchemaNames) {
    const values = (await sourceKnex(sn)) as RawValueMap[];
    await copyValues(
      destKnex,
      sn,
      values,
      [],
      childTableColumnMap,
      schemaMap[sn]
    );
  }
}

async function copyItem(sourceKnex: Knex, destKnex: Knex, schema: Schema) {
  const values = (await sourceKnex(ModelNameEnum.Item)) as RawValueMap[];
  values.forEach((value) => {
    value.for = 'Both';
  });

  await copyValues(destKnex, ModelNameEnum.Item, values, [], {}, schema);
}

async function copyParty(sourceKnex: Knex, destKnex: Knex, schema: Schema) {
  const values = (await sourceKnex(ModelNameEnum.Party)) as RawValueMap[];
  values.forEach((value) => {
    // customer will be mapped onto role
    if (Number(value.supplier) === 1) {
      value.customer = 'Supplier';
    } else {
      value.customer = 'Customer';
    }
  });

  await copyValues(
    destKnex,
    ModelNameEnum.Party,
    values,
    ['supplier', 'addressDisplay'],
    { customer: 'role' },
    schema
  );
}

async function copySingleValues(
  sourceKnex: Knex,
  destKnex: Knex,
  schemaMap: SchemaMap
) {
  const singleSchemaNames = Object.keys(schemaMap).filter(
    (k) => schemaMap[k]?.isSingle
  );
  const singleValues = (await sourceKnex(ModelNameEnum.SingleValue).whereIn(
    'parent',
    singleSchemaNames
  )) as RawValueMap[];
  await copyValues(destKnex, ModelNameEnum.SingleValue, singleValues);
}

async function copyValues(
  destKnex: Knex,
  destTableName: string,
  values: RawValueMap[],
  keysToDelete: string[] = [],
  keyMap: Record<string, string> = {},
  schema?: Schema
) {
  keysToDelete = [...keysToDelete, ...ignoreColumns];
  keyMap = { ...keyMap, ...columnMap };

  values = values.map((sv) => deleteKeys(sv, keysToDelete));
  values = values.map((sv) => changeKeys(sv, keyMap));

  if (schema) {
    values.forEach((v) => notNullify(v, schema));
  }

  if (schema) {
    const newKeys = schema?.fields.map((f) => f.fieldname);
    values.forEach((v) => deleteOldKeys(v, newKeys));
  }

  await destKnex.batchInsert(destTableName, values, 100);
}

async function getCountryCode(knex: Knex) {
  /**
   * Need to account for schema changes, in 0.4.3-beta.0
   */
  const country = (
    (await knex('SingleValue')
      .select('value')
      .where({ fieldname: 'country' })) as { value: string }[]
  )?.[0]?.value;

  if (!country) {
    return '';
  }

  return getCountryCodeFromCountry(country);
}

function notNullify(map: RawValueMap, schema: Schema) {
  for (const field of schema.fields) {
    if (!field.required || !getIsNullOrUndef(map[field.fieldname])) {
      continue;
    }

    switch (field.fieldtype) {
      case FieldTypeEnum.Float:
      case FieldTypeEnum.Int:
      case FieldTypeEnum.Check:
        map[field.fieldname] = 0;
        break;
      case FieldTypeEnum.Currency:
        map[field.fieldname] = '0.00000000000';
        break;
      case FieldTypeEnum.Table:
        continue;
      default:
        map[field.fieldname] = '';
    }
  }
}

function deleteOldKeys(map: RawValueMap, newKeys: string[]) {
  for (const key of Object.keys(map)) {
    if (newKeys.includes(key)) {
      continue;
    }

    delete map[key];
  }
}

export default { execute, preflight, beforeMigrate: true };
