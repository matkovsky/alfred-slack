// Turns iamcal's emoji-data (the dataset Slack's shortcodes come from) into the compact
// map the workflow ships: { e: { name: "👔" }, s: { name: ["👋🏻", …5 skin tones] } }.
// Usage: osascript -l JavaScript tools/build-emoji.js <emoji-datasource.json> <out.json>
ObjC.import('Cocoa');

const TONES = ['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF']; // Slack's :skin-tone-2: … :skin-tone-6:

function chars(unified) {
  return String.fromCodePoint(...unified.split('-').map(h => parseInt(h, 16)));
}

function run(argv) {
  const [input, out] = argv;
  const text = $.NSString.stringWithContentsOfFileEncodingError(input, $.NSUTF8StringEncoding, null);
  if (text.isNil()) throw new Error('cannot read ' + input);
  const data = JSON.parse(text.js);

  const e = {}, s = {};
  data.forEach(item => {
    const base = chars(item.unified);
    const skins = item.skin_variations && TONES.every(t => item.skin_variations[t])
      ? TONES.map(t => chars(item.skin_variations[t].unified)) : null;
    item.short_names.forEach(name => {
      e[name] = base;
      if (skins) s[name] = skins;
    });
  });

  $(JSON.stringify({ e, s })).writeToFileAtomicallyEncodingError(out, true, $.NSUTF8StringEncoding, null);
  return 'wrote ' + out + ': ' + Object.keys(e).length + ' names, ' + Object.keys(s).length + ' with skin tones';
}
