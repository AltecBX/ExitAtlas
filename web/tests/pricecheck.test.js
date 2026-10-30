// Links to official consumer price pages (engine/pricecheck.js). Same expectations as PriceCheckTests.swift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleMapsLink, gasBuddyLink, slug } from '../js/engine/pricecheck.js';

test('Google Maps: the brand near the station, as a documented Maps URLs search', () => {
  assert.equal(googleMapsLink({ name: 'Shell', brand: 'Shell', coordinate: { lat: 40.931234, lon: -73.898761 } }),
    'https://www.google.com/maps/search/?api=1&query=Shell%2040.93123%2C-73.89876');
  assert.equal(googleMapsLink({ name: 'Mobil Mart', brand: '', coordinate: { lat: 40.9, lon: -73.9 } }),
    'https://www.google.com/maps/search/?api=1&query=Mobil%20Mart%2040.90000%2C-73.90000');
});

test('GasBuddy: the city page, else the state page, never a guess', () => {
  assert.equal(gasBuddyLink({ city: 'Yonkers', state: 'New York' }), 'https://www.gasbuddy.com/gasprices/new-york/yonkers');
  assert.equal(gasBuddyLink({ city: 'Yonkers', state: 'NY' }), 'https://www.gasbuddy.com/gasprices/new-york/yonkers');
  assert.equal(gasBuddyLink({ city: "Coeur d'Alene", state: 'ID' }), 'https://www.gasbuddy.com/gasprices/idaho/coeur-dalene');
  assert.equal(gasBuddyLink({ city: null, state: 'NJ' }), 'https://www.gasbuddy.com/gasprices/new-jersey');
  assert.equal(gasBuddyLink({ city: 'Yonkers', state: null }), null);
  assert.equal(gasBuddyLink({ city: 'Toronto', state: 'Ontario' }), null);
  assert.equal(slug('St. Mary’s'), 'st-marys');
});
