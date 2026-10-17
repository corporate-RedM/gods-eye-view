import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceLocator } from '../data/placeLocator.js';
import { cameraAddress } from './whereAmIModel.js';
import {
  cameraPickerLabel,
  cameraPickerStatus,
  cameraSearchText,
  filterCameraPickerRows,
} from './cctvCataloguePicker.js';

test('a search row shows where the camera is, who runs it and its playback status', () => {
  const camera = {
    id: 'fdot-1',
    name: 'I-95 at Glades Rd',
    city: 'Florida',
    provider: 'FDOT',
    feedType: 'hls',
    playback: { status: 'available' },
  };
  const label = cameraPickerLabel(camera, {
    line: 'Boca Raton, Florida, United States',
  });
  assert.equal(label.name, 'I-95 at Glades Rd');
  assert.equal(label.place, 'Boca Raton, Florida, United States');
  assert.equal(label.meta, 'FDOT · HLS');
  assert.equal(label.status, 'available');
  assert.equal(label.availability, 'Playback checked');
});

test('every playback result stays on the row, and a stream that failed reads as down', () => {
  assert.deepEqual(
    cameraPickerStatus({ playback: { status: 'unavailable' } }),
    {
      status: 'unavailable',
      label: 'Temporarily unavailable',
    },
  );
  assert.deepEqual(cameraPickerStatus({ playback: { status: 'unverified' } }), {
    status: 'unverified',
    label: 'Playback unverified',
  });
  assert.deepEqual(cameraPickerStatus({}), {
    status: 'unchecked',
    label: 'Not checked yet',
  });
  assert.deepEqual(
    cameraPickerStatus({ liveFailed: true, playback: { status: 'available' } }),
    { status: 'unavailable', label: 'Temporarily unavailable' },
  );
});

test('before the place packs load, a row shows the provider city', () => {
  const label = cameraPickerLabel({
    id: 'q-1',
    name: 'Queens Blvd',
    city: 'Queens',
    provider: 'NY511',
  });
  assert.equal(label.place, 'Queens');
});

test('search finds cameras by country, country code, state and continent', async () => {
  const locator = createPlaceLocator();
  await locator.ready();
  const cameras = [
    {
      id: 'lisbon-1',
      name: 'Praça do Comércio',
      city: 'Lisbon',
      provider: 'Webcam',
      lat: 38.7075,
      lon: -9.1364,
    },
    {
      id: 'ba-1',
      name: 'Obelisco',
      city: 'Buenos Aires',
      provider: 'Webcam',
      lat: -34.6037,
      lon: -58.3816,
    },
    {
      id: 'fdot-1',
      name: 'I-95 at Glades Rd',
      city: 'Florida',
      provider: 'FDOT',
      lat: 26.3683,
      lon: -80.1289,
    },
  ];
  const located = new Map(
    cameras.map((camera) => {
      const fix = locator.locate(camera.lat, camera.lon, { snapToLand: true });
      const address = cameraAddress(camera, fix, {
        isAreaName: locator.isAreaName,
      });
      return [
        camera.id,
        { address, text: cameraSearchText(camera, address, fix) },
      ];
    }),
  );
  assert.equal(located.get('lisbon-1').address.line, 'Lisbon, Portugal');
  assert.equal(located.get('ba-1').address.line, 'Buenos Aires, Argentina');
  const ids = (query) =>
    filterCameraPickerRows(
      cameras,
      query,
      (camera) => located.get(camera.id).text,
    ).map((camera) => camera.id);
  assert.deepEqual(ids('Portugal'), ['lisbon-1']);
  assert.deepEqual(ids('argentina'), ['ba-1']);
  assert.deepEqual(ids('PRT'), ['lisbon-1']);
  assert.deepEqual(ids('florida united states'), ['fdot-1']);
  assert.deepEqual(ids('Europe'), ['lisbon-1']);
});
