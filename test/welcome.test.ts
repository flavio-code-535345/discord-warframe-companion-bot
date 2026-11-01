import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { welcomeText } from '../src/discord/welcome.js';

describe('the welcome greeting', () => {
  it('points a new member at the rules, the guide, the screenshot roles and the Ordis channel', () => {
    const text = welcomeText('Cephalon Ordis', { rules: 'r1', guide: 'g1', ssRoles: 's1', chat: 'c1' });
    assert.match(text, /^Cephalon Ordis is pleased to have you aboard/);
    for (const id of ['r1', 'g1', 's1', 'c1']) assert.match(text, new RegExp(`<#${id}>`));
    assert.match(text, /`\/lfg`/);
  });

  it('points at the role menu when there is one', () => {
    assert.match(welcomeText('Ordis', { rules: null, guide: null, roles: 'ro1', ssRoles: null, chat: null }), /Pick your platform.*<#ro1>/);
  });

  it('leaves out what is not set up', () => {
    const text = welcomeText('Ordis', { rules: null, guide: null, ssRoles: null, chat: 'c1' });
    assert.doesNotMatch(text, /rules|screenshot|ranks/);
    assert.equal(text.split('\n• ').length, 3, 'the Ordis channel and /lfg');
  });
});
