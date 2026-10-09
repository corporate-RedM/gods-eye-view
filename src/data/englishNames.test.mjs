import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraPackForId,
  englishCameraCode,
  englishCameraName,
  englishPlaceName,
  englishProviderName,
} from './englishNames.js';

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
  assert.equal(englishPlaceName('Montréal (Ville-Marie)'), 'Montreal (Ville-Marie)');
  assert.equal(englishPlaceName('Pärnu'), 'Pärnu');
  assert.equal(englishPlaceName('Tallinn, Estonia'), 'Tallinn, Estonia');
  assert.equal(englishProviderName('Stadt Warendorf'), 'City of Warendorf');
  assert.equal(
    englishProviderName('Transpordiamet (Tarktee)'),
    'Estonian Transport Administration (Tarktee)',
  );
  assert.equal(englishProviderName('Fintraffic'), 'Fintraffic');
});
