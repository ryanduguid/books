import { Address } from 'models/baseModels/Address/Address';
import test from 'tape';
import { getCountryInfo } from 'utils/misc';

test('Address country list is sorted alphabetically by locale', (t) => {
  const countryList = (Address.lists as { country(): string[] }).country();
  const expected = Object.keys(getCountryInfo()).sort((a, b) =>
    a.localeCompare(b)
  );
  t.deepEqual(countryList, expected, 'country list in localeCompare order');
  t.end();
});

test('Address state list is sorted alphabetically by locale', (t) => {
  const stateList = (Address.lists as { state(doc?: unknown): string[] }).state(
    {
      country: 'India',
    }
  );
  t.deepEqual(
    stateList,
    [...stateList].sort((a, b) => a.localeCompare(b)),
    'state list in localeCompare order'
  );
  t.end();
});
