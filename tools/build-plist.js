// Generates the workflow's info.plist (as JSON; the Makefile converts it with plutil).
// Usage: osascript -l JavaScript tools/build-plist.js <out.json> <version>
ObjC.import('Cocoa');

const MOD = { none: 0, shift: 131072, ctrl: 262144, alt: 524288, cmd: 1048576, fn: 8388608 };
const RUN = '/usr/bin/osascript -l JavaScript slack.js';

const UID = {
  search: 'A1F0C001-0000-4000-8000-000000000001',
  token: 'A1F0C001-0000-4000-8000-000000000002',
  input: 'A1F0C001-0000-4000-8000-000000000003',
  refreshKw: 'A1F0C001-0000-4000-8000-000000000004',
  action: 'A1F0C001-0000-4000-8000-000000000005',
  refresh: 'A1F0C001-0000-4000-8000-000000000006',
  notify: 'A1F0C001-0000-4000-8000-000000000007',
};

function scriptFilter(uid, keyword, title, subtext, command, opts) {
  return {
    type: 'alfred.workflow.input.scriptfilter', uid, version: 3,
    config: Object.assign({
      alfredfiltersresults: false, alfredfiltersresultsmatchmode: 0,
      argumenttreatemptyqueryasnil: false, argumenttrimmode: 0, argumenttype: 1,
      escaping: 102, keyword, queuedelaycustom: 3, queuedelayimmediatelyinitially: true,
      queuedelaymode: 0, queuemode: 2, runningsubtext: 'Searching Slack…',
      script: RUN + ' ' + command + ' "$1"', scriptargtype: 1, scriptfile: '',
      subtext, title, type: 0, withspace: true,
    }, opts || {}),
  };
}

function runScript(uid, command) {
  return {
    type: 'alfred.workflow.action.script', uid, version: 2,
    // osascript always prints a trailing newline, which Alfred treats as a non-empty
    // query and would post an empty notification; only emit real text.
    config: { concurrently: false, escaping: 102, script: 'out=$(' + RUN + ' ' + command + ')\nprintf %s "$out"', scriptargtype: 1, scriptfile: '', type: 0 },
  };
}

function link(to, modifiers, subtext) {
  return { destinationuid: to, modifiers: modifiers || 0, modifiersubtext: subtext || '', vitoclose: false };
}

function run(argv) {
  const [out, version] = argv;
  if (!version) throw new Error('version argument is required (derived from the git tag by the Makefile)');
  const readme = $.NSString.stringWithContentsOfFileEncodingError('README.md', $.NSUTF8StringEncoding, null);

  const plist = {
    bundleid: 'com.matkovsky.alfred-slack',
    name: 'Slack',
    description: 'Jump to Slack channels, DMs and group DMs across workspaces',
    createdby: 'Peter Matkovsky',
    webaddress: 'https://github.com/matkovsky/alfred-slack',
    version,
    readme: readme.isNil() ? '' : readme.js,
    disabled: false,
    objects: [
      scriptFilter(UID.search, '{var:keyword}', 'Search Slack', 'Channels, people and group DMs across your workspaces', 'filter'),
      scriptFilter(UID.token, '{var:keyword}:token', 'Slack: connect workspaces', 'Paste a User OAuth Token (xoxp-…) or manage existing ones', 'token',
        { runningsubtext: 'Checking token…', queuemode: 1, queuedelaymode: 1, queuedelayimmediatelyinitially: false }),
      scriptFilter(UID.input, '{var:keyword}:input', 'Slack: compose', 'Opened via ⌃↩ (message) or fn↩ (alias) on a result', 'input',
        { runningsubtext: '' }),
      {
        type: 'alfred.workflow.input.keyword', uid: UID.refreshKw, version: 1,
        config: { argumenttype: 2, keyword: '{var:keyword}:refresh', subtext: 'Re-fetch channels and people for all connected workspaces', text: 'Slack: refresh cache', withspace: false },
      },
      runScript(UID.action, 'action "$1"'),
      runScript(UID.refresh, 'refresh'),
      {
        type: 'alfred.workflow.output.notification', uid: UID.notify, version: 1,
        config: { lastpathcomponent: false, onlyshowifquerypopulated: true, removeextension: false, text: '{query}', title: 'Slack' },
      },
    ],
    connections: {
      [UID.search]: [
        link(UID.action),
        link(UID.action, MOD.cmd, 'Copy link'),
        link(UID.action, MOD.alt, 'Open in browser'),
        link(UID.input, MOD.ctrl, 'Send a quick message'),
        link(UID.input, MOD.fn, 'Add an alias'),
      ],
      [UID.token]: [link(UID.action), link(UID.action, MOD.cmd, 'Remove token')],
      [UID.input]: [link(UID.action)],
      [UID.refreshKw]: [link(UID.refresh)],
      [UID.action]: [link(UID.notify)],
      [UID.refresh]: [link(UID.notify)],
    },
    uidata: {
      [UID.search]: { xpos: 40, ypos: 40 },
      [UID.token]: { xpos: 40, ypos: 200 },
      [UID.refreshKw]: { xpos: 40, ypos: 360 },
      [UID.input]: { xpos: 300, ypos: 200 },
      [UID.action]: { xpos: 560, ypos: 40 },
      [UID.refresh]: { xpos: 300, ypos: 360 },
      [UID.notify]: { xpos: 820, ypos: 40 },
    },
    userconfigurationconfig: [
      {
        type: 'textfield', variable: 'keyword', label: 'Keyword', description: 'Main keyword. Also used as prefix for :token, :refresh.',
        config: { default: 'sl', placeholder: 'sl', required: true, trim: true },
      },
      {
        type: 'textarea', variable: 'workspaces', label: 'Workspaces',
        description: 'One workspace per line, in priority order (ties are ranked in this order). Use the Slack domain, name or team ID, optionally "=prefix" for "sl prefix: query". Prefix a line with "-" to hide that workspace. Empty = Slack sidebar order.',
        config: { default: '', placeholder: 'acme=a\nlorem-ipsum=li\nanother-team=at', required: false, trim: true, verticalsize: 5 },
      },
      {
        type: 'textfield', variable: 'refresh_hours', label: 'Refresh after (hours)', description: 'Cache age after which channels and people are re-fetched in the background.',
        config: { default: '6', placeholder: '6', required: false, trim: true },
      },
      {
        type: 'textfield', variable: 'fallback_delay', label: 'Fallback delay (seconds)', description: 'Wait after switching workspace before pressing ⌘K. Raise it if keystrokes get lost.',
        config: { default: '0.8', placeholder: '0.8', required: false, trim: true },
      },
    ],
  };

  $(JSON.stringify(plist, null, 2)).writeToFileAtomicallyEncodingError(out, true, $.NSUTF8StringEncoding, null);
  return 'wrote ' + out;
}
