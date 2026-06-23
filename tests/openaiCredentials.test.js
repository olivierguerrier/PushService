'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const openaiCredentials = require('../src/openaiCredentials');

describe('openaiCredentials', () => {
  beforeEach(() => {
    openaiCredentials.clearCache();
  });

  it('returns inline OPENAI_API_KEY without calling the vault', async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-inline-test-key';
    try {
      assert.equal(await openaiCredentials.getApiKey(), 'sk-inline-test-key');
    } finally {
      if (prev == null) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it('defaults the vault provider to openai', () => {
    const prev = process.env.CT_OPENAI_VAULT_PROVIDER;
    delete process.env.CT_OPENAI_VAULT_PROVIDER;
    try {
      assert.equal(openaiCredentials.vaultProvider(), 'openai');
    } finally {
      if (prev == null) delete process.env.CT_OPENAI_VAULT_PROVIDER;
      else process.env.CT_OPENAI_VAULT_PROVIDER = prev;
    }
  });
});
