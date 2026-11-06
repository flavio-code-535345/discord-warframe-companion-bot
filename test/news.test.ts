import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gameNews, newsEmbed, steamNews, steamText, withoutDuplicates } from '../src/discord/news.js';
import type { WorldState } from '../src/warframe/worldstate.js';

const NOW = Date.UTC(2026, 10, 6, 12);
const DAY = 86_400_000;
const iso = (ago: number): string => new Date(NOW - ago).toISOString();

const news = (over: Record<string, unknown>) => ({ id: 'a', message: 'Update 40.1: Hotfix', link: 'https://forums.warframe.com/x', imageLink: 'https://img/x.png', date: iso(DAY), update: true, primeAccess: false, stream: false, mobileOnly: false, ...over });
const world = (...items: Record<string, unknown>[]) => ({ news: items }) as unknown as WorldState;

describe('in-game news', () => {
  it('tags updates, Prime Access and Devstreams, and keeps the link and picture', () => {
    const items = gameNews(
      world(news({}), news({ id: 'b', message: 'Prime Access: Foo', update: false, primeAccess: true }), news({ id: 'c', message: 'Devstream 200', update: false, stream: true }), news({ id: 'd', message: 'Dev Workshop', update: false })),
      NOW,
    );
    assert.deepEqual(items.map((i) => i.tag), ['🛠️ Update', '💎 Prime Access', '🎬 Devstream', '📰 News']);
    assert.equal(items[0]!.url, 'https://forums.warframe.com/x');
    assert.equal(items[0]!.image, 'https://img/x.png');
    assert.equal(items[0]!.key, 'news:game:a');
  });

  it('leaves out mobile-only posts, old posts and a placeholder picture', () => {
    const items = gameNews(world(news({ id: 'm', mobileOnly: true }), news({ id: 'o', date: iso(9 * DAY) }), news({ id: 'p', imageLink: 'https://cdn/img/news-placeholder.png' })), NOW);
    assert.deepEqual(items.map((i) => i.key), ['news:game:p']);
    assert.equal(items[0]!.image, null);
  });

  it('copes with no world state', () => {
    assert.deepEqual(gameNews(null, NOW), []);
  });
});

describe('Steam announcements', () => {
  const item = (over: Record<string, unknown>) => ({ gid: '1', title: 'Update 40.1', url: 'https://steamcommunity.com/ogg/230410/1', contents: '[h2]Fixes[/h2] [list][*]One[*]Two[/list] {STEAM_CLAN_IMAGE}/x.png', date: Math.floor((NOW - DAY) / 1000), feedname: 'steam_community_announcements', ...over });

  it('strips the BBCode and keeps only the developer feed', () => {
    const items = steamNews([item({}), item({ gid: '2', feedname: 'pcgamer' })], NOW);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.text, 'Fixes One Two');
    assert.equal(items[0]!.tag, '🛠️ Update (Steam)');
  });

  it('drops a tag cut off by the length limit and shortens long text', () => {
    assert.equal(steamText('Hello [url=https://x'), 'Hello');
    assert.ok(steamText('word '.repeat(200), 50).length <= 50);
  });

  it('skips posts older than a week', () => {
    assert.deepEqual(steamNews([item({ date: Math.floor((NOW - 8 * DAY) / 1000) })], NOW), []);
  });
});

describe('both sources together', () => {
  it('keeps the in-game post when Steam has one with the same title', () => {
    const game = gameNews(world(news({})), NOW);
    const steam = steamNews([{ gid: '9', title: 'update 40.1: hotfix!', url: 'https://s/9', contents: '', date: Math.floor((NOW - DAY) / 1000), feedname: 'steam_community_announcements' }, { gid: '10', title: 'Something else', url: 'https://s/10', contents: '', date: Math.floor((NOW - DAY) / 1000), feedname: 'steam_community_announcements' }], NOW);
    assert.deepEqual(withoutDuplicates(game, steam).map((i) => i.key), ['news:game:a', 'news:steam:10']);
  });

  it('builds an embed that links the post', () => {
    const embed = newsEmbed(gameNews(world(news({})), NOW)[0]!).toJSON();
    assert.equal(embed.title, 'Update 40.1: Hotfix');
    assert.equal(embed.url, 'https://forums.warframe.com/x');
    assert.equal(embed.author?.name, '🛠️ Update');
  });
});
