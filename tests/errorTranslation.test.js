'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const errorTranslation = require('../src/errorTranslation');
const openaiCredentials = require('../src/openaiCredentials');

describe('errorTranslation', () => {
  beforeEach(() => {
    errorTranslation.clearCache();
  });

  it('treats US/CA/GB/AU as English marketplaces', () => {
    assert.equal(errorTranslation.isEnglishMarketplace('US'), true);
    assert.equal(errorTranslation.isEnglishMarketplace('DE'), false);
    assert.equal(errorTranslation.needsTranslation('US', '100095: invalid value'), false);
    assert.equal(errorTranslation.needsTranslation('DE', '101165: Dein Artikel'), true);
  });

  it('uses curated error-code reference as fallback translation', () => {
    const english = errorTranslation.fallbackEnglish('101165: Dein Artikel stimmt mit mehreren Produkten überein', [
      { code: '101165', message: 'Dein Artikel stimmt mit mehreren Produkten überein', attributeNames: [] }
    ]);
    assert.match(english, /Identifiers match multiple/);
    assert.match(english, /101165/);
  });

  it('enriches records with English copies for English marketplaces', async () => {
    const records = [{
      marketplace_code: 'US',
      error_message: '100095: invalid finish type',
      errorDetails: [{ code: '100095', message: 'invalid finish type', attributeNames: ['finish_type'] }]
    }];
    await errorTranslation.enrichRecords(records);
    assert.equal(records[0].error_message_en, '100095: invalid finish type');
    assert.equal(records[0].errorDetailsEn[0], '100095: invalid finish type [finish_type]');
  });

  it('enriches non-English records using fallback when OpenAI is unavailable', async () => {
    // Force the no-LLM path: deleting the env var is not enough because the key
    // is also resolvable from the ControlTower vault, so stub the resolver.
    const realGetApiKey = openaiCredentials.getApiKey;
    openaiCredentials.getApiKey = async () => '';
    try {
      const records = [{
        marketplace_code: 'IT',
        error_message: null,
        errorDetails: [{ code: '101161', message: 'Questo errore si verifica quando provi a modificare lo SKU', attributeNames: [] }]
      }];
      await errorTranslation.enrichRecords(records);
      assert.match(records[0].error_message_en, /101161/);
      assert.match(records[0].error_message_en, /already listed/i);
    } finally {
      openaiCredentials.getApiKey = realGetApiKey;
    }
  });
});
