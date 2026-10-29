import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config, getAtUssdCallbackUrl } from '../src/config.ts';

describe('Africa’s Talking USSD callback configuration', () => {
  it('accepts an HTTPS callback URL for the USSD route', () => {
    const previousUrl = config.atUssdCallbackUrl;
    config.atUssdCallbackUrl = 'https://service.example.com/gateway/ussd';
    try {
      assert.equal(getAtUssdCallbackUrl(), 'https://service.example.com/gateway/ussd');
    } finally {
      config.atUssdCallbackUrl = previousUrl;
    }
  });

  it('rejects callback URLs that cannot be used for the USSD route', () => {
    const previousUrl = config.atUssdCallbackUrl;
    try {
      for (const url of [
        'not a URL',
        'http://service.example.com/gateway/ussd',
        'https://service.example.com/other',
        'https://user:pass@service.example.com/gateway/ussd',
      ]) {
        config.atUssdCallbackUrl = url;
        assert.throws(getAtUssdCallbackUrl, /AT_USSD_CALLBACK_URL must be an absolute HTTPS URL/);
      }
    } finally {
      config.atUssdCallbackUrl = previousUrl;
    }
  });

  it('allows the callback URL to remain unset outside the deployed USSD setup', () => {
    const previousUrl = config.atUssdCallbackUrl;
    config.atUssdCallbackUrl = '';
    try {
      assert.equal(getAtUssdCallbackUrl(), undefined);
    } finally {
      config.atUssdCallbackUrl = previousUrl;
    }
  });
});
