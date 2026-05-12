const SONNET_MODEL = 'claude-sonnet-4-6';
const OPUS_MODEL = 'claude-opus-4-7';
const RECIPIENT_EMAIL = 'trae.clevenger@gmail.com';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const PREFERRED_SOURCES = [
  'Anthropic (anthropic.com)',
  'OpenAI (openai.com)',
  'Google DeepMind (deepmind.google)',
  'Google AI blog (blog.google/technology/ai)',
  'Meta AI (ai.meta.com)',
  'Microsoft AI (microsoft.com/ai)',
  'Ars Technica',
  'The Verge',
  'MIT Technology Review',
  'TechCrunch',
  'Wired',
  'Stratechery',
  'Latent Space',
  'The Information',
  'arXiv (cs.AI / cs.LG / cs.CL)',
  'Hugging Face Papers',
  'Hacker News (AI-related top stories)',
];

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runShortlist') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runShortlist').timeBased().atHour(7).everyDays(1).create();

  Logger.log('Trigger created for runShortlist at 7am daily.');
  Logger.log('');
  Logger.log('Remaining setup:');
  Logger.log('  1. Project Settings > Script Properties:');
  Logger.log('       ANTHROPIC_API_KEY = <key from console.anthropic.com>');
  Logger.log('       SITE_URL          = https://traeclevenger.github.io/ai-shortlist');
  Logger.log('  2. Deploy > New Deployment > Web app:');
  Logger.log('       Execute as: Me');
  Logger.log('       Who has access: Anyone');
  Logger.log('  3. Copy the deployment URL and paste it into index.html as APPS_SCRIPT_URL.');
  Logger.log('  4. (Optional) Run runShortlist() once to test end-to-end.');
}

function runShortlist() {
  pruneOldShortlists();

  const today = formatDate(new Date());
  let shortlist;
  try {
    shortlist = fetchShortlist(today);
  } catch (e) {
    notifyError('Shortlist fetch failed', e);
    return;
  }

  if (!shortlist || shortlist.length === 0) {
    notifyError('Empty shortlist', new Error('Sonnet returned no items'));
    return;
  }

  const token = generateToken();
  PropertiesService.getScriptProperties().setProperty(
    'shortlist:' + today,
    JSON.stringify({ shortlist: shortlist, token: token })
  );

  const html = renderShortlistEmail(today, token, shortlist);
  GmailApp.sendEmail(
    RECIPIENT_EMAIL,
    'AI Morning Shortlist — ' + today,
    'Open this email in an HTML-capable client to see the buttons.',
    { htmlBody: html }
  );
}

function fetchShortlist(today) {
  const system =
    "You are a senior tech analyst surfacing the most interesting AI news from the last 24 hours.\n\n" +
    "Today's date is " + today + ". Search for AI news, research, blogs, and analysis published in the last 24 hours.\n\n" +
    "Prioritize these sources:\n" +
    PREFERRED_SOURCES.map(function (s) { return '- ' + s; }).join('\n') + "\n\n" +
    "Other reputable AI/tech sources are also welcome.\n\n" +
    "Return EXACTLY 5 items as a JSON array inside <shortlist>...</shortlist> tags. Each item:\n" +
    "  - source: which publication (e.g. \"Anthropic\", \"Ars Technica\")\n" +
    "  - headline: the article's actual headline\n" +
    "  - url: full URL to the article\n" +
    "  - summary: 2 sentences on what makes this interesting or noteworthy\n\n" +
    "Pick items that are intellectually substantive — research, product launches with implications, considered analysis. Skip rumor pieces, listicles, and pure marketing.\n\n" +
    "Output ONLY the JSON inside the tags. No preamble, no postamble.";

  let messages = [{ role: 'user', content: "Build today's shortlist." }];
  let response;

  for (let i = 0; i < 5; i++) {
    response = callClaude({
      model: SONNET_MODEL,
      max_tokens: 4000,
      system: system,
      messages: messages,
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    });
    if (response.stop_reason !== 'pause_turn') break;
    messages = [
      { role: 'user', content: "Build today's shortlist." },
      { role: 'assistant', content: response.content },
    ];
  }

  const text = extractText(response);
  const match = text.match(/<shortlist>([\s\S]*?)<\/shortlist>/);
  if (!match) {
    throw new Error('No <shortlist> tag in response. First 500 chars: ' + text.slice(0, 500));
  }
  return JSON.parse(match[1].trim());
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: 'ai-shortlist' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const date = body.date;
    const choice = parseInt(body.choice, 10);
    const token = body.token;

    if (!date || isNaN(choice) || !token) {
      return respond({ error: 'Missing required parameters.' });
    }

    const stored = PropertiesService.getScriptProperties().getProperty('shortlist:' + date);
    if (!stored) return respond({ error: 'No shortlist on file for ' + date + '.' });

    const parsed = JSON.parse(stored);
    if (token !== parsed.token) return respond({ error: 'Token mismatch.' });
    if (choice < 1 || choice > parsed.shortlist.length) {
      return respond({ error: 'Choice out of range.' });
    }

    const article = parsed.shortlist[choice - 1];
    const post = writePost(article);

    GmailApp.sendEmail(
      RECIPIENT_EMAIL,
      'Draft LinkedIn post — ' + article.source,
      post + '\n\n---\nSource: ' + article.headline + '\n' + article.url,
      {
        htmlBody:
          '<div style="max-width:640px;margin:0 auto;padding:24px;font-family:Georgia,serif;">' +
          '<p style="white-space:pre-wrap;font-size:16px;line-height:1.6;color:#111;">' +
          escapeHtml(post) +
          '</p><hr style="margin:24px 0;border:0;border-top:1px solid #ddd;">' +
          '<p style="font-family:Helvetica,Arial,sans-serif;color:#666;font-size:13px;margin:0;">' +
          'Source: ' + escapeHtml(article.headline) + '<br>' +
          '<a href="' + escapeAttr(article.url) + '">' + escapeAttr(article.url) + '</a>' +
          '</p></div>',
      }
    );

    return respond({ ok: true, source: article.source, headline: article.headline });
  } catch (err) {
    notifyError('doPost failed', err);
    return respond({ error: err.message });
  }
}

function writePost(article) {
  const system =
    "You write LinkedIn posts about AI for a business audience.\n\n" +
    "Voice:\n" +
    "- Intelligent but relatable. No buzzwords. No jargon. No \"thought leadership\" voice.\n" +
    "- Pithy. Often humorous. One paragraph ideally, two at most. Keep sentences short and words simple.\n" +
    "- Sometimes the right move is a historical comparison (printing press, electrification, early days of search, etc.) — two sentences max, don't over-explain it. Sometimes it's a dry or funny observation. Don't force either. Only reach for one if it genuinely sharpens the point.\n" +
    "- Focus on implications: what this means for business or society, for responsible AI use, or for where technology is headed.\n" +
    "- Don't summarize the article — react to it. Take a position.\n" +
    "- Don't open with the headline or \"Just read about...\". Open with the idea.\n" +
    "- NEVER open with \"Turns out\", \"It turns out\", or any variation. This is a hard rule.\n" +
    "- NEVER use em dashes (—). Hard rule. Break into two sentences instead.\n" +
    "- Historical comparisons must be one sentence maximum. Don't explain the analogy — state it and move on.\n" +
    "- Plain text only. No hashtags. No emojis. No \"thoughts?\" at the end.\n\n" +
    "End the post with the article's URL on its own line.";

  const userPrompt =
    'Article:\n' +
    'Source: ' + article.source + '\n' +
    'Headline: ' + article.headline + '\n' +
    'URL: ' + article.url + '\n\n' +
    "What's noteworthy: " + article.summary + '\n\n' +
    'Write the LinkedIn post.';

  const response = callClaude({
    model: OPUS_MODEL,
    max_tokens: 2000,
    system: system,
    messages: [{ role: 'user', content: userPrompt }],
    thinking: { type: 'adaptive' },
  });

  return extractText(response).trim();
}

function callClaude(payload) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in Script Properties.');

  const response = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error('Claude API ' + code + ': ' + body);
  return JSON.parse(body);
}

function extractText(response) {
  return (response.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n');
}

function renderShortlistEmail(date, token, shortlist) {
  const siteUrl = PropertiesService.getScriptProperties().getProperty('SITE_URL');
  if (!siteUrl) throw new Error('SITE_URL not set in Script Properties.');

  const cards = shortlist.map(function (item, i) {
    const writeUrl =
      siteUrl.replace(/\/$/, '') +
      '/?date=' + encodeURIComponent(date) +
      '&choice=' + (i + 1) +
      '&token=' + encodeURIComponent(token);
    return '' +
      '<div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin-bottom:16px;background:white;font-family:Helvetica,Arial,sans-serif;">' +
        '<div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#888;margin-bottom:4px;">' +
          escapeHtml(item.source) +
        '</div>' +
        '<h3 style="margin:0 0 8px;font-size:18px;line-height:1.3;color:#111;">' +
          escapeHtml(item.headline) +
        '</h3>' +
        '<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#444;">' +
          escapeHtml(item.summary) +
        '</p>' +
        '<p style="margin:0;">' +
          '<a href="' + escapeAttr(writeUrl) + '" style="display:inline-block;padding:8px 14px;background:#0a66c2;color:white;text-decoration:none;border-radius:4px;font-size:14px;font-weight:600;">Write this one</a>' +
          '<a href="' + escapeAttr(item.url) + '" style="display:inline-block;padding:8px 14px;margin-left:8px;color:#0a66c2;text-decoration:none;font-size:14px;">View article →</a>' +
        '</p>' +
      '</div>';
  }).join('');

  return '' +
    '<div style="max-width:640px;margin:0 auto;padding:24px;background:#fafafa;">' +
      '<h2 style="font-family:Georgia,serif;color:#111;margin:0 0 4px;">AI Morning Shortlist</h2>' +
      '<p style="font-family:Helvetica,Arial,sans-serif;color:#666;font-size:14px;margin:0 0 24px;">' +
        escapeHtml(date) + " — pick one and I'll draft the post." +
      '</p>' +
      cards +
    '</div>';
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function notifyError(subject, err) {
  Logger.log('Error: ' + subject + ' — ' + err);
  try {
    GmailApp.sendEmail(RECIPIENT_EMAIL, '[AI Shortlist] ' + subject, String((err && err.stack) || err));
  } catch (_) {}
}

function generateToken() {
  const bytes = [];
  for (let i = 0; i < 12; i++) {
    bytes.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  }
  return bytes.join('');
}

function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

function pruneOldShortlists() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('shortlist:') !== 0) return;
    const dateStr = key.slice('shortlist:'.length);
    if (new Date(dateStr) < cutoff) props.deleteProperty(key);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function escapeAttr(s) {
  return escapeHtml(s);
}
