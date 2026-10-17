import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraPackForId,
  englishCameraCode,
  englishCameraName,
  englishPlaceName,
  englishProviderName,
} from './englishNames.js';
import { filterCameraPickerRows } from '../ui/cctvCataloguePicker.js';

test('Taiwan road labels preserve route suffixes, distance, direction and landmarks in English', () => {
  const cases = [
    ['國道10號 W 33K+590', 'National Freeway 10 westbound 33 km + 590'],
    ['台74線10K+970', 'Provincial Highway 74 10 km + 970'],
    ['台2戊006K+900', 'Provincial Highway 2E 006 km + 900'],
    ['台14甲線31K+500武嶺', 'Provincial Highway 14A 31 km + 500 Wuling'],
    [
      '台9線125K+412順樁(S)',
      'Provincial Highway 9 125 km + 412 toward increasing kilometer markers (southbound)',
    ],
    [
      '台9線128K+342逆樁(N)',
      'Provincial Highway 9 128 km + 342 toward decreasing kilometer markers (northbound)',
    ],
    [
      '台20臨105線0K+036',
      'Provincial Highway 20, Temporary Route 105 0 km + 036',
    ],
    ['中118線004K+700', 'Taichung Route 118 004 km + 700'],
    ['144線1K+150西', 'County Highway 144 1 km + 150 westbound'],
    ['高港高架 E 0K+000', 'Kaohsiung Port Elevated Road eastbound 0 km + 000'],
  ];
  for (const [original, expected] of cases)
    assert.equal(englishCameraName(original), expected);
});

test('multilingual camera names and locality details use English without guessing a different location', () => {
  assert.equal(englishCameraName('대신방향(160M)'), 'Toward Daesin (160 m)');
  assert.equal(
    englishCameraName('黃金海岸，台南市南區 (HD)'),
    'Gold Coast, South District, Tainan (HD)',
  );
  assert.equal(englishPlaceName('Geoje (고현동)'), 'Geoje (Gohyeon-dong)');
  assert.equal(
    englishPlaceName('釧路海上保安部'),
    'Kushiro Coast Guard Office',
  );
  assert.equal(
    englishPlaceName('大阪海上保安監部'),
    'Osaka Coast Guard Office',
  );
  assert.equal(englishPlaceName('Междуреченск'), 'Mezhdurechensk');
  assert.equal(englishPlaceName('台東区'), 'Taito');
  assert.equal(englishPlaceName('頭城鎮'), 'Toucheng Township');
  assert.equal(englishPlaceName('斗六市'), 'Douliu');
  assert.equal(englishPlaceName('บ้านเฉวง'), 'Ban Chaweng');
  assert.equal(englishPlaceName('Unknown locality'), 'Unknown locality');
});

test('translated cameras remain searchable by both English and original names and places', () => {
  const camera = {
    id: 'road-1',
    name: 'National Freeway 1',
    originalName: '國道1號',
    city: 'Toucheng Township',
    originalCity: '頭城鎮',
    provider: 'Taiwan Freeway Bureau',
  };
  for (const query of [
    'National Freeway',
    '國道1號',
    'Toucheng',
    '頭城鎮',
    'Taiwan road-1',
  ]) {
    assert.deepEqual(filterCameraPickerRows([camera], query), [camera]);
  }
  assert.deepEqual(filterCameraPickerRows([camera], 'unrelated'), []);
});

test('translated cameras get an English label code by the server rule', () => {
  assert.equal(
    englishCameraCode('Viru Street retractable bollard'),
    'VIRU STREET RETRACTABLE BOL…',
  );
  assert.equal(englishCameraCode('Freedom Square'), 'FREEDOM SQUARE');
  assert.equal(cameraPackForId('tln-103'), 'tallinn');
  assert.equal(cameraPackForId('ee-tarktee-55'), 'estonia');
  assert.equal(cameraPackForId('fi-c1455101'), 'finland');
  assert.equal(cameraPackForId('austin-1'), '');
});

test('Tallinn camera names read in English', () => {
  const cases = [
    [
      'Viru väljak (suund Mere pst ja Narva mnt)',
      'Viru Square (toward Mere Avenue and Narva Highway)',
    ],
    ['Viru tn langetatav pollar', 'Viru Street retractable bollard'],
    [
      'Kadaka tee-Akadeemia tee(linnast välja)',
      'Kadaka Road - Akadeemia Road (out of the city)',
    ],
    [
      'Sõpruse pst-Endla tn-Tulika tn(ülevaade)',
      'Sõpruse Avenue - Endla Street - Tulika Street (overview)',
    ],
    [
      'Estonia pst - Teatri väljak (suund Reaalkool)',
      'Estonia Avenue - Theatre Square (toward Reaalkool)',
    ],
    [
      'Kalev P&R (sissepääs), Pärnu mnt 150',
      'Kalev Park & Ride (entrance), Pärnu Highway 150',
    ],
    ['Lasnamäele (tunnelis)', 'To Lasnamäe (in the tunnel)'],
    [
      'Narva mnt (suund linnast välja) - Vormsi tn',
      'Narva Highway (heading out of the city) - Vormsi Street',
    ],
    [
      'Toompuiestee - Tehnika tn (suund Baltijaam)',
      'Toompuiestee - Tehnika Street (toward Baltic Station)',
    ],
  ];
  for (const [estonian, english] of cases)
    assert.equal(englishCameraName(estonian, 'tallinn'), english);
});

test('compound names keep their hyphens and proper names stay', () => {
  assert.equal(
    englishCameraName('Pärnu mnt - Suur-Ameerika tn', 'tallinn'),
    'Pärnu Highway - Suur-Ameerika Street',
  );
  assert.equal(
    englishCameraName('Vana-Kalamaja pollar', 'tallinn'),
    'Vana-Kalamaja bollard',
  );
  assert.equal(englishCameraName('Kilingi-Nõmme', 'estonia'), 'Kilingi-Nõmme');
  assert.equal(
    englishCameraName('Randvere-Lubja ristmik', 'estonia'),
    'Randvere-Lubja intersection',
  );
});

test('Finnish road codes become English road names', () => {
  assert.equal(
    englishCameraName('vt4 Rovaniemi Revontuli 5 (view 01)', 'finland'),
    'Highway 4, Rovaniemi Revontuli 5 (view 01)',
  );
  assert.equal(
    englishCameraName('kt40 Turku Kärsämäki Testi (view 02)', 'finland'),
    'Main Road 40, Turku Kärsämäki test (view 02)',
  );
  assert.equal(
    englishCameraName('st101 Puomi Länsi (view 00)', 'finland'),
    'Regional Road 101, west barrier (view 00)',
  );
  assert.equal(
    englishCameraName('vt12 Tre Rantatunneli puomi l (view 01)', 'finland'),
    'Highway 12, Tampere Ranta Tunnel west barrier (view 01)',
  );
  assert.equal(
    englishCameraName('vt4 Rovaniemi Napapiiri', 'finland'),
    'Highway 4, Rovaniemi Arctic Circle',
  );
  assert.equal(englishCameraName('vt4', 'finland'), 'Highway 4');
});

test('the Warendorf webcam reads in English', () => {
  assert.equal(
    englishCameraName('Marktplatz / Historisches Rathaus', 'warendorf'),
    'Market Square / Historic Town Hall',
  );
});

test('English-language packs pass through untouched', () => {
  for (const [name, cityId] of [
    ['IH 35 at Cesar Chavez', 'tx-sat'],
    ['Hwy 50 at Sunrise Blvd EO WB 2 (Rancho Cordova)', 'ca-d3'],
    ['Trafalgar Square', 'london'],
    ['tee time', ''],
  ])
    assert.equal(englishCameraName(name, cityId), name);
});

test('places and operators with an English name get it', () => {
  assert.equal(englishPlaceName('Montréal'), 'Montreal');
  assert.equal(englishPlaceName('Québec'), 'Quebec City');
  assert.equal(
    englishPlaceName('Montréal (Ville-Marie)'),
    'Montreal (Ville-Marie)',
  );
  assert.equal(englishPlaceName('Pärnu'), 'Pärnu');
  assert.equal(englishPlaceName('Tallinn, Estonia'), 'Tallinn, Estonia');
  assert.equal(englishProviderName('Stadt Warendorf'), 'City of Warendorf');
  assert.equal(
    englishProviderName('Transpordiamet (Tarktee)'),
    'Estonian Transport Administration (Tarktee)',
  );
  assert.equal(englishProviderName('Fintraffic'), 'Fintraffic');
});
