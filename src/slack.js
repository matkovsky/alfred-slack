// Alfred ⇄ Slack workflow — single JXA entry point.
// Usage: osascript -l JavaScript slack.js <command> [query]
//   filter <q>   main Script Filter (keyword `sl`)
//   token <q>    Script Filter for managing per-workspace tokens (`sl:token`)
//   input <q>    chained Script Filter: compose a message / name an alias
//   action <arg> run the action selected in a Script Filter (reads $action etc.)
//   refresh      rebuild the cache for all workspaces with a token
//   dump-mpim    debug: print raw group-DM objects (to check for custom names)

ObjC.import('Cocoa');
ObjC.import('stdlib');

const KEYCHAIN_SERVICE = 'alfred-slack';
const SLACK_STATE = '~/Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/storage/root-state.json';
const SLACK_STATE_DIRECT = '~/Library/Application Support/Slack/storage/root-state.json'; // non-App-Store build
const MAX_RESULTS = 50;

// ───────────────────────── basics ─────────────────────────

const app = Application.currentApplication();
app.includeStandardAdditions = true;

function env(name, fallback) {
  const v = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}

function expand(p) { return $(p).stringByExpandingTildeInPath.js; }

function fileExists(p) { return $.NSFileManager.defaultManager.fileExistsAtPath(p); }

function readFile(p) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  return s.isNil() ? null : s.js;
}

function writeFile(p, text) {
  mkdirp($(p).stringByDeletingLastPathComponent.js);
  $(text).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null);
}

function readJSON(p, fallback) {
  const s = readFile(p);
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function writeJSON(p, obj) { writeFile(p, JSON.stringify(obj)); }

function mkdirp(dir) {
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), null);
}

function removeFile(p) { $.NSFileManager.defaultManager.removeItemAtPathError(p, null); }

function mtime(p) {
  const attrs = $.NSFileManager.defaultManager.attributesOfItemAtPathError(p, null);
  if (attrs.isNil()) return 0;
  return attrs.objectForKey('NSFileModificationDate').timeIntervalSince1970 * 1000;
}

function sh(cmd) { return app.doShellScript(cmd); }

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function sleep(seconds) { $.NSThread.sleepForTimeInterval(seconds); }

const CACHE_DIR = env('alfred_workflow_cache', expand('~/Library/Caches/com.runningwithcrayons.Alfred/Workflow Data/com.matkovsky.alfred-slack'));
const DATA_DIR = env('alfred_workflow_data', expand('~/Library/Application Support/Alfred/Workflow Data/com.matkovsky.alfred-slack'));
const LOCK = CACHE_DIR + '/refresh.lock';

// ───────────────────────── text helpers ─────────────────────────

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const EMOJI = {
  necktie: '👔', tada: '🎉', rocket: '🚀', fire: '🔥', star: '⭐', heart: '❤️', bulb: '💡', memo: '📝',
  calendar: '📅', money_with_wings: '💸', moneybag: '💰', briefcase: '💼', computer: '💻', bug: '🐛',
  wrench: '🔧', hammer: '🔨', gear: '⚙️', lock: '🔒', key: '🔑', bell: '🔔', loudspeaker: '📢', mega: '📣',
  speech_balloon: '💬', eyes: '👀', wave: '👋', coffee: '☕', pizza: '🍕', beer: '🍺', beers: '🍻',
  house: '🏠', office: '🏢', art: '🎨', books: '📚', book: '📖', chart_with_upwards_trend: '📈',
  bar_chart: '📊', package: '📦', construction: '🚧', warning: '⚠️', white_check_mark: '✅',
  x: '❌', zap: '⚡', sparkles: '✨', robot_face: '🤖', robot: '🤖', ghost: '👻', crown: '👑',
  trophy: '🏆', dart: '🎯', paperclip: '📎', pushpin: '📌', mag: '🔍', link: '🔗', email: '📧',
  phone: '📱', iphone: '📱', camera: '📷', movie_camera: '🎥', musical_note: '🎵', headphones: '🎧',
  earth_africa: '🌍', earth_americas: '🌎', globe_with_meridians: '🌐', sunny: '☀️', rainbow: '🌈',
  seedling: '🌱', evergreen_tree: '🌲', cat: '🐱', dog: '🐶', unicorn_face: '🦄', thumbsup: '👍',
  '+1': '👍', ok_hand: '👌', raised_hands: '🙌', clap: '👏', muscle: '💪', brain: '🧠', handshake: '🤝',
  family: '👪', busts_in_silhouette: '👥', bust_in_silhouette: '👤', moyai: '🗿', shield: '🛡️',
  hourglass: '⌛', alarm_clock: '⏰', receipt: '🧾', shopping_trolley: '🛒', truck: '🚚',
  red_circle: '🔴', large_green_circle: '🟢', large_blue_circle: '🔵', large_yellow_circle: '🟡',
  flag_hu: '🇭🇺', hu: '🇭🇺', flag_gb: '🇬🇧', flag_us: '🇺🇸', flag_de: '🇩🇪',
};

function emojify(s) {
  return String(s || '').replace(/:([a-z0-9_+\-]+):/g, (m, code) => EMOJI[code] || m);
}

// ───────────────────────── Alfred output ─────────────────────────

function alfredOutput(items, extra) {
  return JSON.stringify(Object.assign({ items }, extra || {}));
}

function infoItem(title, subtitle, extra) {
  return Object.assign({ title, subtitle: subtitle || '', valid: false }, extra || {});
}

// ───────────────────────── workspaces & config ─────────────────────────

// Workspaces come from Slack's own local state (no auth needed), ordered by
// the user's `Workspaces` config (one `domain=prefix` per line), then by Slack's order.
function loadWorkspaces() {
  const override = env('slack_state', '');
  let state = override ? readJSON(override, null)
    : readJSON(expand(SLACK_STATE), null) || readJSON(expand(SLACK_STATE_DIRECT), null);
  let list = state && state.workspaces ? Object.values(state.workspaces) : [];
  list = list.map(w => ({
    id: w.id, name: w.name, domain: w.domain, url: w.url || ('https://' + w.domain + '.slack.com/'),
    iconUrl: w.icon && (w.icon.image_132 || w.icon.image_88 || w.icon.image_68 || w.icon.image_44),
    slackOrder: typeof w.order === 'number' ? w.order : 999,
  }));
  // Fall back to cached copy if Slack state is unavailable (e.g. moved install).
  if (!list.length) list = readJSON(CACHE_DIR + '/workspaces.json', []);
  else writeJSON(CACHE_DIR + '/workspaces.json', list);

  const config = parseWorkspaceConfig(env('workspaces', ''));
  list.forEach(w => {
    const c = config.find(c => [fold(w.domain), fold(w.name), fold(w.id)].includes(c.key));
    w.rank = c ? c.index : 1000 + w.slackOrder;
    w.prefix = c && c.prefix ? c.prefix : defaultPrefix(w);
    w.hidden = !!(c && c.hidden);
  });
  list.sort((a, b) => a.rank - b.rank);
  return list.filter(w => !w.hidden);
}

// "kuix=k" / "creative-factory = cf" / "-acme" (hide)
function parseWorkspaceConfig(text) {
  return String(text).split(/\n|,/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map((line, index) => {
    const hidden = line.startsWith('-');
    const [key, prefix] = line.replace(/^-/, '').split('=').map(s => s && s.trim());
    return { key: fold(key), prefix: prefix ? fold(prefix) : '', index, hidden };
  });
}

function defaultPrefix(w) {
  const words = fold(w.name).split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 1 ? words.map(x => x[0]).join('') : (words[0] || fold(w.domain)).slice(0, 1);
}

function iconPath(w) {
  const p = CACHE_DIR + '/icons/' + w.id + '.png';
  return fileExists(p) ? p : null;
}

// ───────────────────────── keychain ─────────────────────────

function getToken(teamId) {
  try {
    return sh('security find-generic-password -s ' + shq(KEYCHAIN_SERVICE) + ' -a ' + shq(teamId) + ' -w 2>/dev/null').trim() || null;
  } catch (e) { return null; }
}

function setToken(teamId, token) {
  sh('security add-generic-password -U -s ' + shq(KEYCHAIN_SERVICE) + ' -a ' + shq(teamId) +
     ' -l ' + shq('Alfred Slack (' + teamId + ')') + ' -w ' + shq(token));
}

function deleteToken(teamId) {
  try { sh('security delete-generic-password -s ' + shq(KEYCHAIN_SERVICE) + ' -a ' + shq(teamId)); } catch (e) {}
}

// ───────────────────────── Slack API ─────────────────────────

function httpPost(url, token, params) {
  const body = Object.keys(params || {}).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  const req = $.NSMutableURLRequest.requestWithURL($.NSURL.URLWithString(url));
  req.HTTPMethod = 'POST';
  req.timeoutInterval = 20;
  req.setValueForHTTPHeaderField('Bearer ' + token, 'Authorization');
  req.setValueForHTTPHeaderField('application/x-www-form-urlencoded; charset=utf-8', 'Content-Type');
  req.HTTPBody = $(body).dataUsingEncoding($.NSUTF8StringEncoding);
  // NB: reading the NSURLResponse via Ref() segfaults osascript, so we only use the body.
  const data = $.NSURLConnection.sendSynchronousRequestReturningResponseError(req, null, null);
  if (data.isNil()) return { ok: false, error: 'network_error' };
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  try { return JSON.parse(text.js); } catch (e) { return { ok: false, error: 'bad_response' }; }
}

function api(token, method, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = httpPost('https://slack.com/api/' + method, token, params);
    if (res.ok || res.error !== 'ratelimited') return res;
    sleep(15 * (attempt + 1)); // Retry-After isn't readable from JXA; back off generously.
  }
  return { ok: false, error: 'ratelimited' };
}

function apiPaged(token, method, params, key) {
  const all = [];
  let cursor = '';
  do {
    const res = api(token, method, Object.assign({ limit: 1000 }, params, cursor ? { cursor } : {}));
    if (!res.ok) throw new Error(method + ': ' + res.error);
    all.push(...(res[key] || []));
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);
  return all;
}

// ───────────────────────── cache build ─────────────────────────

function cachePath(teamId) { return CACHE_DIR + '/' + teamId + '.json'; }

function refreshWorkspace(w, token) {
  const users = apiPaged(token, 'users.list', {}, 'members');
  const byId = {}, byHandle = {};
  users.forEach(u => { byId[u.id] = u; byHandle[fold(u.name)] = u; });

  const publicChannels = apiPaged(token, 'conversations.list',
    { types: 'public_channel', exclude_archived: true }, 'channels');
  const mine = apiPaged(token, 'users.conversations',
    { types: 'private_channel,mpim', exclude_archived: true }, 'channels');

  const entries = [];
  const userName = u => (u.profile && (u.profile.real_name || u.profile.display_name)) || u.real_name || u.name;

  publicChannels.concat(mine.filter(c => !c.is_mpim)).forEach(c => {
    entries.push({
      kind: c.is_private ? 'private' : 'channel',
      id: c.id,
      name: c.name,
      title: (c.is_private ? '🔒 ' : '# ') + c.name,
      keys: [c.name, c.name.replace(/[-_]/g, ' ')],
      member: !!c.is_member || !!c.is_private,
      details: emojify((c.topic && c.topic.value) || (c.purpose && c.purpose.value) || ''),
      members: c.num_members || null,
    });
  });

  mine.filter(c => c.is_mpim).forEach(c => {
    // Group DM names look like "mpdm-alice--bob--carol-1"; map handles back to people.
    const handles = c.name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--');
    const people = handles.filter(h => fold(h) !== fold(w.selfName))
      .map(h => byHandle[fold(h)] ? userName(byHandle[fold(h)]) : h);
    const custom = customGroupName(c);
    entries.push({
      kind: 'group',
      id: c.id,
      name: custom || people.join(', '),
      title: '👥 ' + (custom ? emojify(custom) : people.join(', ')),
      keys: [custom, people.join(' '), ...people].filter(Boolean),
      member: true,
      details: custom ? 'with ' + people.join(', ') : '',
      members: handles.length,
    });
  });

  users.filter(u => !u.deleted && !u.is_bot && !u.is_app_user && u.id !== 'USLACKBOT').forEach(u => {
    const p = u.profile || {};
    const real = p.real_name || u.real_name || u.name;
    const display = p.display_name && p.display_name !== real ? p.display_name : '';
    entries.push({
      kind: 'user',
      id: u.id,
      name: real,
      title: '@ ' + real + (display ? ' (' + display + ')' : ''),
      keys: [real, display, u.name, p.email].filter(Boolean),
      member: true,
      details: [emojify(p.status_emoji ? p.status_emoji + ' ' + (p.status_text || '') : p.status_text || ''), p.title, u.tz_label]
        .filter(Boolean).join(' · '),
      self: u.id === w.selfId,
    });
  });

  writeJSON(cachePath(w.id), { updated: Date.now(), team: w.id, entries });
  if (w.iconUrl) downloadIcon(w);
  return entries.length;
}

// Slack lets you name a group DM in the app; it isn't documented which API field
// carries that name, so check the plausible ones and ignore the auto "mpdm-…" name.
function customGroupName(c) {
  const candidates = [c.properties && c.properties.name, c.display_name, c.custom_name,
    c.name_normalized !== c.name ? c.name_normalized : null];
  return candidates.find(n => n && typeof n === 'string' && !/^mpdm-/.test(n)) || null;
}

function downloadIcon(w) {
  const data = $.NSData.dataWithContentsOfURL($.NSURL.URLWithString(w.iconUrl));
  if (!data.isNil()) {
    mkdirp(CACHE_DIR + '/icons');
    data.writeToFileAtomically(CACHE_DIR + '/icons/' + w.id + '.png', true);
  }
}

function refreshAll() {
  writeFile(LOCK, String(Date.now()));
  const report = [];
  try {
    loadWorkspaces().forEach(w => {
      const token = getToken(w.id);
      if (!token) return;
      try {
        const auth = api(token, 'auth.test', {});
        if (!auth.ok) throw new Error('auth.test: ' + auth.error);
        w.selfId = auth.user_id; w.selfName = auth.user;
        report.push(w.name + ': ' + refreshWorkspace(w, token));
      } catch (e) {
        report.push(w.name + ': ' + e.message);
        writeJSON(CACHE_DIR + '/' + w.id + '.error.json', { error: e.message, at: Date.now() });
        return;
      }
      removeFile(CACHE_DIR + '/' + w.id + '.error.json');
    });
  } finally {
    removeFile(LOCK);
  }
  return report.join('\n') || 'No workspace has a token yet — run sl:token';
}

function refreshInBackground() {
  if (isRefreshing()) return;
  writeFile(LOCK, String(Date.now()));
  sh('cd ' + shq(scriptDir()) + ' && nohup /usr/bin/osascript -l JavaScript slack.js refresh >/dev/null 2>&1 &');
}

function isRefreshing() {
  // Stale locks (crashed refresh) expire after 5 minutes.
  return fileExists(LOCK) && Date.now() - mtime(LOCK) < 5 * 60 * 1000;
}

function scriptDir() {
  // osascript is invoked with a path relative to the workflow folder.
  const args = $.NSProcessInfo.processInfo.arguments.js.map(a => a.js);
  const script = args.find(a => /slack\.js$/.test(a)) || 'slack.js';
  const full = script.startsWith('/') ? script : env('PWD', '.') + '/' + script;
  return $(full).stringByDeletingLastPathComponent.js;
}

// ───────────────────────── search ─────────────────────────

function scoreKeys(keys, q) {
  let best = 0;
  for (const raw of keys) {
    const k = fold(raw);
    if (!k) continue;
    let s = 0;
    if (k === q) s = 100;
    else if (k.startsWith(q)) s = 80;
    else if (k.split(/[\s\-_.,()]+/).some(word => word.startsWith(q))) s = 60;
    else if (k.includes(q)) s = 40;
    else if (q.split(/\s+/).length > 1 && q.split(/\s+/).every(part => k.includes(part))) s = 50;
    else if (isSubsequence(q.replace(/\s+/g, ''), k)) s = 15;
    if (s > best) best = s;
  }
  return best;
}

function isSubsequence(q, s) {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

const KIND_ORDER = { channel: 0, private: 0, user: 1, group: 2 };
const KIND_LABEL = { channel: 'Channel', private: 'Private channel', group: 'Group DM', user: 'Direct message' };

function loadAliases() { return readJSON(DATA_DIR + '/aliases.json', []); }

function search(query) {
  let workspaces = loadWorkspaces();
  let q = query.trim();

  // Optional workspace prefix: "k: design" / "cf:design"
  const m = q.match(/^([^\s:]+):\s*(.*)$/);
  if (m) {
    const ws = workspaces.filter(w => w.prefix === fold(m[1]) || fold(w.domain) === fold(m[1]));
    if (ws.length) { workspaces = ws; q = m[2]; }
  }
  const fq = fold(q);
  const aliases = loadAliases();

  const items = [];
  let stale = false;
  const tokenless = [];
  const refreshHours = parseFloat(env('refresh_hours', '6')) || 6;

  workspaces.forEach(w => {
    const cache = readJSON(cachePath(w.id), null);
    // Don't hammer a failing workspace: after an error, wait 30 min before retrying.
    const err = readJSON(CACHE_DIR + '/' + w.id + '.error.json', null);
    const mayRetry = !err || Date.now() - err.at > 30 * 60 * 1000;
    if (!cache) {
      if (!getToken(w.id)) tokenless.push(w);
      else if (mayRetry) stale = true;
      return;
    }
    if (mayRetry && Date.now() - cache.updated > refreshHours * 3600 * 1000) stale = true;
    const icon = iconPath(w);
    const wsAliases = aliases.filter(a => a.team === w.id);

    cache.entries.forEach(e => {
      const extraKeys = wsAliases.filter(a => a.id === e.id).map(a => a.name);
      const keys = extraKeys.concat(e.keys);
      let score = fq ? scoreKeys(keys, fq) : (e.member && e.kind !== 'user' ? 1 : 0);
      if (!score) return;
      // A hit on a user-defined alias beats an equally good hit on a generated name.
      if (fq && extraKeys.length && scoreKeys(extraKeys, fq) === score) score += 5;
      const title = extraKeys.length ? (e.kind === 'group' ? '👥 ' : '') + emojify(extraKeys[0]) : e.title;
      items.push({ e, w, icon, title, score });
    });
  });

  items.sort((a, b) =>
    b.score - a.score ||
    a.w.rank - b.w.rank ||
    (b.e.member ? 1 : 0) - (a.e.member ? 1 : 0) ||
    KIND_ORDER[a.e.kind] - KIND_ORDER[b.e.kind] ||
    a.title.localeCompare(b.title));

  const out = items.slice(0, MAX_RESULTS).map(({ e, w, icon, title }) => resultItem(e, w, icon, title));

  // Fallback: Slack's own quick switcher (⌘K). Always for tokenless workspaces,
  // and for every workspace when the cache has no match.
  if (q) {
    const fallbackWs = out.length ? tokenless : workspaces;
    fallbackWs.forEach(w => out.push(fallbackItem(w, q)));
  } else if (!items.length) {
    out.push(infoItem('Type to search Slack channels, people and group DMs',
      tokenless.length === workspaces.length ? 'No tokens yet — run "sl:token" to connect a workspace' : 'Prefix with a workspace, e.g. "' + (workspaces[0] ? workspaces[0].prefix : 'k') + ': design"'));
  }

  const refreshing = isRefreshing();
  if (stale && !refreshing) refreshInBackground();
  const extra = {};
  if (stale || refreshing) {
    extra.rerun = 1;
    if (out.length) out[0].subtitle = '⟳ Refreshing Slack cache… · ' + out[0].subtitle;
    else out.push(infoItem('Refreshing Slack cache…', 'Fetching channels and people'));
  }
  return alfredOutput(out, extra);
}

function linkFor(e, w) {
  return 'https://' + w.domain + '.slack.com/' + (e.kind === 'user' ? 'team/' : 'archives/') + e.id;
}

function resultItem(e, w, icon, title) {
  const deeplink = e.kind === 'user'
    ? 'slack://user?team=' + w.id + '&id=' + e.id
    : 'slack://channel?team=' + w.id + '&id=' + e.id;
  const browser = 'https://app.slack.com/client/' + w.id + '/' + e.id;
  const label = (e.kind === 'user' ? '@' : e.kind === 'group' ? '' : '#') + (e.kind === 'group' ? title.replace(/^👥 /, '') : e.name);
  const kind = KIND_LABEL[e.kind] + (e.kind === 'channel' && !e.member ? ' (not joined)' : '') + (e.self ? ' (you)' : '');
  const details = [e.details, e.members ? e.members + ' members' : '', w.name].filter(Boolean).join(' · ');
  const vars = { team: w.id, target: e.id, kind: e.kind, label, workspace: w.name, domain: w.domain };
  return {
    uid: w.id + ':' + e.id,
    title,
    subtitle: w.name + ' · ' + kind,
    arg: deeplink,
    autocomplete: (e.kind === 'user' ? e.name : e.name),
    icon: icon ? { path: icon } : undefined,
    variables: Object.assign({ action: 'open' }, vars),
    text: { copy: linkFor(e, w), largetype: title },
    quicklookurl: browser,
    mods: {
      cmd: { subtitle: '⌘ Copy link: ' + linkFor(e, w), arg: linkFor(e, w), variables: Object.assign({ action: 'copy' }, vars) },
      alt: { subtitle: '⌥ Open in browser', arg: browser, variables: Object.assign({ action: 'browser' }, vars) },
      ctrl: { subtitle: '⌃ Send a quick message to ' + label, arg: '', variables: Object.assign({ action: 'message' }, vars) },
      fn: { subtitle: 'fn Add an alias for ' + label, arg: '', variables: Object.assign({ action: 'alias' }, vars) },
      shift: { subtitle: details || w.name, valid: false },
    },
  };
}

function fallbackItem(w, q) {
  return {
    uid: 'fallback:' + w.id,
    title: 'Search ' + w.name + ' for “' + q + '”',
    subtitle: '⌘K in Slack (' + w.name + ')' + (getToken(w.id) ? '' : ' · no token for this workspace'),
    arg: q,
    icon: iconPath(w) ? { path: iconPath(w) } : undefined,
    variables: { action: 'fallback', team: w.id, workspace: w.name },
  };
}

// ───────────────────────── token management (sl:token) ─────────────────────────

function tokenFilter(query) {
  const q = query.trim();
  const workspaces = loadWorkspaces();
  if (/^xox[a-z]-/.test(q)) {
    const auth = api(q, 'auth.test', {});
    if (!auth.ok) return alfredOutput([infoItem('Token rejected by Slack: ' + auth.error, 'Paste a User OAuth Token (xoxp-…)')]);
    const w = workspaces.find(w => w.id === auth.team_id) || { name: auth.team, id: auth.team_id };
    return alfredOutput([{
      title: 'Save token for ' + w.name,
      subtitle: 'Authenticated as ' + auth.user + ' · stored in the macOS Keychain',
      arg: q,
      variables: { action: 'token_save', team: auth.team_id, workspace: w.name },
    }]);
  }
  const items = workspaces.map(w => {
    const has = !!getToken(w.id);
    const err = readJSON(CACHE_DIR + '/' + w.id + '.error.json', null);
    const cache = readJSON(cachePath(w.id), null);
    const status = has
      ? (err ? '⚠️ ' + err.error : cache ? '✓ ' + cache.entries.length + ' items, updated ' + ago(cache.updated) : '✓ token saved, not synced yet')
      : '✗ no token — paste one after "sl:token " · ↩ opens Slack app setup';
    return {
      uid: 'token:' + w.id,
      title: w.name + ' (' + w.domain + ') · prefix "' + w.prefix + ':"',
      subtitle: status,
      arg: 'https://api.slack.com/apps?new_app=1',
      valid: !has,
      icon: iconPath(w) ? { path: iconPath(w) } : undefined,
      variables: { action: 'url' },
      mods: has ? { cmd: { subtitle: '⌘ Remove token for ' + w.name, valid: true, arg: '', variables: { action: 'token_delete', team: w.id, workspace: w.name } } } : undefined,
    };
  });
  items.push({
    title: 'Refresh cache now', subtitle: 'Re-fetch channels and people for all connected workspaces',
    arg: '', variables: { action: 'refresh' },
  });
  return alfredOutput(items);
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  if (m < 48 * 60) return Math.round(m / 60) + ' h ago';
  return Math.round(m / 1440) + ' days ago';
}

// ───────────────────────── chained input (message / alias) ─────────────────────────

function inputFilter(query) {
  const mode = env('action', '');
  const label = env('label', '');
  const q = query;
  if (mode === 'alias') {
    return alfredOutput([q.trim()
      ? { title: 'Save alias “' + q.trim() + '” → ' + label, subtitle: 'Searchable via "sl ' + q.trim() + '"', arg: q.trim(), variables: { action: 'alias_save' } }
      : infoItem('Type an alias for ' + label, 'e.g. Team Leads :necktie:')]);
  }
  return alfredOutput([q.trim()
    ? { title: 'Send to ' + label + ': ' + q, subtitle: '↩ posts as you in ' + env('workspace', 'Slack'), arg: q, variables: { action: 'send' } }
    : infoItem('Message to ' + label + '…', 'Type your message, ↩ to send as you')]);
}

// ───────────────────────── actions ─────────────────────────

function doAction(arg) {
  const action = env('action', 'open');
  const team = env('team', '');
  switch (action) {
    case 'open':
    case 'browser':
    case 'url':
      sh('open ' + shq(arg));
      return '';
    case 'copy':
      $.NSPasteboard.generalPasteboard.clearContents;
      $.NSPasteboard.generalPasteboard.setStringForType($(arg), $.NSPasteboardTypeString);
      return 'Copied link to ' + env('label', '');
    case 'fallback':
      return quickSwitch(team, arg);
    case 'send': {
      const token = getToken(team);
      if (!token) return 'No token for ' + env('workspace', team);
      const res = api(token, 'chat.postMessage', { channel: env('target', ''), text: arg });
      return res.ok ? 'Sent to ' + env('label', '') : 'Slack error: ' + res.error + (res.error === 'missing_scope' ? ' (add chat:write user scope)' : '');
    }
    case 'alias_save': {
      const aliases = loadAliases().filter(a => !(a.team === team && a.id === env('target', '') && a.name === arg));
      aliases.push({ team, id: env('target', ''), kind: env('kind', ''), name: arg });
      writeJSON(DATA_DIR + '/aliases.json', aliases);
      return 'Alias “' + arg + '” saved';
    }
    case 'token_save':
      setToken(team, arg);
      refreshAll();
      return 'Token saved for ' + env('workspace', team) + ' — cache refreshed';
    case 'token_delete':
      deleteToken(team);
      removeFile(cachePath(team));
      return 'Token removed for ' + env('workspace', team);
    case 'refresh':
      return refreshAll();
  }
  return 'Unknown action: ' + action;
}

// Switch to the workspace, open Slack's quick switcher, type the query, hit return.
function quickSwitch(team, query) {
  sh('open ' + shq('slack://open?team=' + team));
  const se = Application('System Events');
  const delay = parseFloat(env('fallback_delay', '0.8')) || 0.8;
  sleep(delay);
  Application('Slack').activate();
  sleep(0.2);
  se.keystroke('k', { using: 'command down' });
  sleep(0.35);
  se.keystroke(query);
  sleep(0.7);
  se.keyCode(36); // return
  return '';
}

// ───────────────────────── debug ─────────────────────────

function dumpMpim() {
  const out = {};
  loadWorkspaces().forEach(w => {
    const token = getToken(w.id);
    if (!token) return;
    const res = api(token, 'users.conversations', { types: 'mpim', limit: 200 });
    out[w.name] = res.ok ? res.channels : res.error;
  });
  return JSON.stringify(out, null, 2);
}

// ───────────────────────── entry ─────────────────────────

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.join(' ');
  switch (cmd) {
    case 'filter': return search(query);
    case 'token': return tokenFilter(query);
    case 'input': return inputFilter(query);
    case 'action': return doAction(query);
    case 'refresh': return refreshAll();
    case 'dump-mpim': return dumpMpim();
    default: return 'usage: slack.js filter|token|input|action|refresh|dump-mpim [query]';
  }
}
