/**
 * tksignal Data Fetcher
 * 
 * Fetches trending data from:
 * - Hacker News (Algolia API)
 * - GitHub Trending (Search API)
 * - arXiv (AI/ML papers)
 * - Y Combinator (Launch HN posts from Algolia)
 * 
 * Outputs JSON to src/data/feed.json for Astro to consume at build time.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml } from 'node-html-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'src', 'data');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const MAX_ITEMS = 30;

// ── LLM Summaries (Google Gemini, free tier) ──
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// Free tier is ~10 RPM; pace requests to stay comfortably under.
const GEMINI_RATE_LIMIT_MS = 6500;

async function fetchJSON(url, options = {}) {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      console.warn(`  Retry ${i + 1} for ${url}: ${err.message}`);
      await sleep(2000 * (i + 1));
    }
  }
}

async function fetchText(url, options = {}) {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.text();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      console.warn(`  Retry ${i + 1} for ${url}: ${err.message}`);
      await sleep(2000 * (i + 1));
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchUrlDescription(url) {
  if (!url || url.includes('news.ycombinator.com')) return '';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return '';
    const html = await res.text();
    const root = parseHtml(html);
    let desc = root.querySelector('meta[property="og:description"]')?.getAttribute('content');
    if (!desc) {
      desc = root.querySelector('meta[name="description"]')?.getAttribute('content');
    }
    return desc ? desc.replace(/\s+/g, ' ').trim().slice(0, 200) + (desc.length > 200 ? '...' : '') : '';
  } catch {
    return '';
  }
}

// ── 1. Hacker News ──
async function fetchHackerNews() {
  console.log('🔥 Fetching Hacker News top stories...');
  try {
    const data = await fetchJSON(
      `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${MAX_ITEMS}`
    );
    const stories = data.hits.map((hit, index) => ({
      rank: index + 1,
      id: hit.objectID,
      title: hit.title || 'Untitled',
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      score: hit.points || 0,
      comments: hit.num_comments || 0,
      author: hit.author || 'unknown',
      time: hit.created_at,
      hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    }));
    
    console.log('  Fetching descriptions for HN stories...');
    for (let i = 0; i < stories.length; i++) {
      if (stories[i].url && !stories[i].url.includes('news.ycombinator.com')) {
        stories[i].description = await fetchUrlDescription(stories[i].url);
      }
    }

    console.log(`  ✅ Fetched ${stories.length} HN stories`);
    return stories;
  } catch (err) {
    console.error(`  ❌ HN Algolia failed, falling back to Firebase: ${err.message}`);
    const ids = await fetchJSON('https://hacker-news.firebaseio.com/v0/topstories.json');
    const topIds = ids.slice(0, MAX_ITEMS);
    const stories = [];
    for (let i = 0; i < topIds.length; i += 10) {
      const batch = topIds.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(id => fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`))
      );
      stories.push(...results.filter(Boolean).map((item, idx) => ({
        rank: i + idx + 1,
        id: String(item.id),
        title: item.title || 'Untitled',
        url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
        score: item.score || 0,
        comments: item.descendants || 0,
        author: item.by || 'unknown',
        time: new Date(item.time * 1000).toISOString(),
        hnUrl: `https://news.ycombinator.com/item?id=${item.id}`,
      })));
    }
    
    console.log('  Fetching descriptions for HN stories...');
    for (let i = 0; i < stories.length; i++) {
      if (stories[i].url && !stories[i].url.includes('news.ycombinator.com')) {
        stories[i].description = await fetchUrlDescription(stories[i].url);
      }
    }

    console.log(`  ✅ Fetched ${stories.length} HN stories (Firebase)`);
    return stories;
  }
}

// ── 2. GitHub Trending (github.com/trending) ──
function parseNumber(text) {
  return parseInt((text || '').replace(/,/g, ''), 10) || 0;
}

async function fetchGitHubTrending() {
  console.log('⭐ Fetching GitHub trending repositories (today)...');
  try {
    const html = await fetchText('https://github.com/trending?since=daily', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });
    const root = parseHtml(html);
    const rows = root.querySelectorAll('article.Box-row').slice(0, MAX_ITEMS);
    if (rows.length === 0) throw new Error('No trending rows found in page');
    const repos = rows.map((row, index) => {
      const href = row.querySelector('h2 a')?.getAttribute('href') || '';
      const fullName = href.replace(/^\//, '');
      const [owner, name] = fullName.split('/');
      const f6Text = row.querySelector('.f6')?.textContent.replace(/\s+/g, ' ') || '';
      const starsTodayMatch = f6Text.match(/([\d,]+)\s+stars today/);
      return {
        rank: index + 1,
        name: name || fullName,
        fullName,
        url: `https://github.com/${fullName}`,
        description: row.querySelector('p')?.textContent.trim() || 'No description',
        stars: parseNumber(row.querySelector('.f6 a[href$="/stargazers"]')?.textContent.replace(/\s+/g, '')),
        forks: parseNumber(row.querySelector('.f6 a[href$="/forks"]')?.textContent.replace(/\s+/g, '')),
        starsToday: starsTodayMatch ? parseNumber(starsTodayMatch[1]) : 0,
        language: row.querySelector('span[itemprop="programmingLanguage"]')?.textContent.trim() || 'Unknown',
        owner,
        ownerAvatar: `https://github.com/${owner}.png`,
        topics: [],
        trending: true,
      };
    });
    console.log(`  ✅ Fetched ${repos.length} GitHub trending repos`);
    return repos;
  } catch (err) {
    console.error(`  ❌ Trending scrape failed (${err.message}), falling back to Search API...`);
    const dateStr = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'tksignal-bot',
    };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const data = await fetchJSON(
      `https://api.github.com/search/repositories?q=created:>${dateStr}+stars:>50&sort=stars&order=desc&per_page=${MAX_ITEMS}`,
      { headers }
    );
    return data.items.map((repo, index) => ({
      rank: index + 1,
      name: repo.name,
      fullName: repo.full_name,
      url: repo.html_url,
      description: repo.description || 'No description',
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      language: repo.language || 'Unknown',
      owner: repo.owner.login,
      ownerAvatar: repo.owner.avatar_url,
      createdAt: repo.created_at,
      updatedAt: repo.pushed_at,
      topics: repo.topics || [],
    }));
  }
}

// ── 3. arXiv ──
async function fetchArxiv() {
  console.log('📚 Fetching arXiv AI/ML papers...');
  const query = 'cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL';
  const url = `https://export.arxiv.org/api/query?search_query=${query}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${MAX_ITEMS}`;
  const xml = await fetchText(url);
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    isArray: (name) => ['entry', 'author', 'category', 'link'].includes(name),
  });
  const feed = parser.parse(xml);
  const entries = feed.feed?.entry || [];
  const papers = entries.map((entry, index) => {
    const links = entry.link || [];
    const pdfLink = links.find(l => l['@_title'] === 'pdf' || (l['@_href'] || '').includes('/pdf/'));
    const absLink = links.find(l => l['@_rel'] === 'alternate');
    const authors = (entry.author || []).map(a => a.name).filter(Boolean);
    const categories = (entry.category || []).map(c => c['@_term']).filter(Boolean);
    const idMatch = (entry.id || '').match(/abs\/(.+)/);
    const arxivId = idMatch ? idMatch[1] : entry.id;
    return {
      rank: index + 1,
      id: arxivId,
      title: (entry.title || '').replace(/\s+/g, ' ').trim(),
      summary: (entry.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300) + '...',
      authors: authors.slice(0, 5),
      authorCount: authors.length,
      categories,
      primaryCategory: entry.primary_category?.['@_term'] || categories[0] || 'cs.AI',
      published: entry.published,
      updated: entry.updated,
      pdfUrl: pdfLink?.['@_href'] || `https://arxiv.org/pdf/${arxivId}`,
      absUrl: absLink?.['@_href'] || `https://arxiv.org/abs/${arxivId}`,
    };
  });
  console.log(`  ✅ Fetched ${papers.length} arXiv papers`);
  return papers;
}

// ── 4. Y Combinator ──
async function fetchYCombinator() {
  console.log('🚀 Fetching Y Combinator startups...');
  try {
    const data = await fetchJSON(
      `https://hn.algolia.com/api/v1/search?query=Launch%20HN&tags=show_hn&hitsPerPage=${MAX_ITEMS}&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - 30 * 86400}`
    );
    const startups = data.hits
      .filter(hit => hit.title && hit.title.includes('Launch HN'))
      .slice(0, MAX_ITEMS)
      .map((hit, index) => {
        const titleMatch = hit.title.match(/Launch HN:\s*(.+?)\s*[–\-—]\s*(.+)/);
        const name = titleMatch ? titleMatch[1].trim() : hit.title.replace('Launch HN:', '').trim();
        const tagline = titleMatch ? titleMatch[2].trim() : '';
        return {
          rank: index + 1,
          id: hit.objectID,
          name,
          tagline,
          url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          score: hit.points || 0,
          comments: hit.num_comments || 0,
          author: hit.author || 'unknown',
          launchDate: hit.created_at,
          description: (hit.story_text || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
        };
      });
    if (startups.length < 10) {
      const showHN = await fetchJSON(
        `https://hn.algolia.com/api/v1/search?tags=show_hn&hitsPerPage=${MAX_ITEMS}&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - 30 * 86400}`
      );
      const additional = showHN.hits
        .filter(hit => !startups.find(s => s.id === hit.objectID))
        .slice(0, MAX_ITEMS - startups.length)
        .map((hit, index) => ({
          rank: startups.length + index + 1,
          id: hit.objectID,
          name: hit.title?.replace(/^Show HN:\s*/i, '').split(/[–\-—]/)[0]?.trim() || hit.title,
          tagline: hit.title?.split(/[–\-—]/)[1]?.trim() || '',
          url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          score: hit.points || 0,
          comments: hit.num_comments || 0,
          author: hit.author || 'unknown',
          launchDate: hit.created_at,
          isShowHN: true,
          description: (hit.story_text || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
        }));
      startups.push(...additional);
    }
    console.log(`  ✅ Fetched ${startups.length} YC/startup launches`);
    return startups;
  } catch (err) {
    console.error(`  ❌ YC fetch failed: ${err.message}`);
    return [];
  }
}

// ── 6. Lobste.rs ──
async function fetchLobsters() {
  console.log('🦞 Fetching Lobste.rs hottest stories...');
  try {
    const data = await fetchJSON('https://lobste.rs/hottest.json');
    if (!Array.isArray(data) || data.length === 0) throw new Error('Empty response');
    const stories = data.slice(0, MAX_ITEMS).map((story, index) => ({
      rank: index + 1,
      id: story.short_id,
      title: story.title || 'Untitled',
      url: story.url || `https://lobste.rs/s/${story.short_id}`,
      lobstersUrl: story.comments_url || `https://lobste.rs/s/${story.short_id}`,
      score: story.score || 0,
      comments: story.comment_count || 0,
      author: story.submitter_user?.username || story.submitter || 'unknown',
      time: story.created_at,
      tags: story.tags || [],
      description: story.description || '',
    }));
    console.log(`  ✅ Fetched ${stories.length} Lobste.rs stories`);
    return stories;
  } catch (err) {
    console.error(`  ❌ Lobste.rs failed: ${err.message}`);
    return [];
  }
}

// ── 7. Hugging Face trending models ──
async function fetchHuggingFaceTrending() {
  console.log('🤗 Fetching Hugging Face trending models...');
  try {
    const data = await fetchJSON(
      `https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=${MAX_ITEMS}`
    );
    if (!Array.isArray(data) || data.length === 0) throw new Error('Empty response');
    const models = data.map((model, index) => ({
      rank: index + 1,
      id: model.id,
      name: model.id.split('/').pop(),
      author: model.id.split('/')[0],
      url: `https://huggingface.co/${model.id}`,
      downloads: model.downloads || 0,
      likes: model.likes || 0,
      trendingScore: model.trendingScore || 0,
      pipeline: model.pipeline_tag || '',
      license: (model.tags || []).find(t => t.startsWith('license:'))?.replace('license:', '') || 'unknown',
      createdAt: model.createdAt,
    }));
    console.log(`  ✅ Fetched ${models.length} trending HF models`);
    return models;
  } catch (err) {
    console.error(`  ❌ Hugging Face failed: ${err.message}`);
    return [];
  }
}

// ── 8. dev.to top articles ──
async function fetchDevTo() {
  console.log('💻 Fetching dev.to top articles...');
  try {
    const data = await fetchJSON(`https://dev.to/api/articles?top=7&per_page=${MAX_ITEMS}`);
    if (!Array.isArray(data) || data.length === 0) throw new Error('Empty response');
    const articles = [];
    for (const [index, a] of data.entries()) {
      let body = '';
      try {
        const full = await fetchJSON(`https://dev.to/api/articles/${a.id}`);
        body = (full.body_markdown || '').replace(/\s+/g, ' ').trim().slice(0, 3000);
      } catch {
        // fall back to description-only summary
      }
      articles.push({
        rank: index + 1,
        id: a.id,
        title: a.title,
        url: a.url,
        description: a.description || '',
        tags: a.tag_list || [],
        author: a.user?.name || 'unknown',
        authorUsername: a.user?.username || '',
        authorAvatar: a.user?.profile_image || '',
        reactions: a.public_reactions_count || 0,
        comments: a.comments_count || 0,
        readingTime: a.reading_time_minutes || 0,
        publishedAt: a.published_at,
        body,
      });
    }
    console.log(`  ✅ Fetched ${articles.length} dev.to articles`);
    return articles;
  } catch (err) {
    console.error(`  ❌ dev.to failed: ${err.message}`);
    return [];
  }
}

// ── 5. LLM Summaries ──
async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1200,
            responseMimeType: 'application/json',
          },
        }),
      });
      if (res.status === 429) {
        lastErr = new Error('429 rate limited');
        console.warn(`    ⏳ Rate limited, backing off ${(attempt + 1) * 20}s...`);
        await sleep((attempt + 1) * 20000);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const err = new Error(`Gemini auth failed (HTTP ${res.status}). Check GEMINI_API_KEY.`);
        err.fatal = true;
        throw err;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        if (/API key|API_KEY/.test(body)) {
          const err = new Error(`Gemini auth failed (HTTP ${res.status}). Check GEMINI_API_KEY.`);
          err.fatal = true;
          throw err;
        }
        if (res.status === 404 || /not found|not supported|no longer available|invalid model/i.test(body)) {
          const err = new Error(
            `Gemini model "${GEMINI_MODEL}" not available (HTTP ${res.status}: ${body}). Set GEMINI_MODEL to a supported model.`
          );
          err.fatal = true;
          throw err;
        }
        throw new Error(`Gemini HTTP ${res.status}: ${body}`);
      }
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err) {
      if (err.fatal) throw err;
      lastErr = err;
      if (String(err.message).startsWith('Gemini HTTP 4')) break;
      await sleep((attempt + 1) * 5000);
    }
  }
  throw lastErr || new Error('Gemini call failed');
}

function parseSummaryJson(text) {
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/m, '').trim();
    const obj = JSON.parse(cleaned);
    return {
      whyRead: typeof obj.whyRead === 'string' ? obj.whyRead.trim() : '',
      summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
    };
  } catch {
    return { whyRead: '', summary: text.trim() };
  }
}

async function generateSummary({ source, title, content }) {
  const prompt = `You are a sharp tech analyst writing for "tksignal", a daily digest of tech signals (in the style of The Daily Diff / tdd.cat). Write a detailed editorial summary of the ${source} item below.

Title: ${title}

${content}

Requirements:
- "whyRead": one punchy sentence explaining why a tech reader should care (the key takeaway).
- "summary": 2-4 detailed paragraphs (150-250 words total) covering what it is, key technical details, and why it matters. Plain prose, no markdown, no bullet lists.

Respond ONLY with valid JSON: {"whyRead": "...", "summary": "..."}`;
  return parseSummaryJson(await callGemini(prompt));
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

async function fetchArticleText(url) {
  if (!url || url.includes('news.ycombinator.com')) return '';
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tksignal-bot/1.0)' },
    });
    if (!res.ok) return '';
    const root = parseHtml(await res.text());
    root.querySelectorAll('script,style,nav,header,footer,aside,form,svg,noscript,iframe').forEach(el => el.remove());
    let text = root.querySelector('article')?.textContent || '';
    if (text.length < 200) {
      text = root.querySelector('main')?.textContent || root.body?.textContent || '';
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 6000);
  } catch {
    return '';
  }
}

async function fetchReadme(fullName, headers) {
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
      headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    return (await res.text())
      .replace(/[#*`>_\-\[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
  } catch {
    return '';
  }
}

async function buildHNContent(story) {
  const article = await fetchArticleText(story.url);
  const text = article || story.description || '';
  return `Domain: ${getHostname(story.url)}\nScore: ${story.score}, Comments: ${story.comments}\n\nContent:\n${text}`;
}

async function buildGitHubContent(repo) {
  const readme = await fetchReadme(repo.fullName, {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'tksignal-bot',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  });
  return `Description: ${repo.description}\nLanguage: ${repo.language}\nStars: ${repo.stars}, Forks: ${repo.forks}\nTopics: ${repo.topics.join(', ') || 'none'}\n\nREADME:\n${readme || 'No README available'}`;
}

function buildArxivContent(paper) {
  return `Authors: ${paper.authors.join(', ')}\nCategories: ${paper.categories.join(', ')}\nPublished: ${paper.published}\n\nAbstract:\n${paper.summary}`;
}

function buildYCContent(startup) {
  return `Type: ${startup.isShowHN ? 'Show HN' : 'Launch HN'}\nScore: ${startup.score}, Comments: ${startup.comments}\nTagline: ${startup.tagline || 'none'}\n\nDescription:\n${startup.description || 'No description available.'}`;
}

async function summarizeAll(results) {
  const tasks = [
    ...results.hackerNews.map(item => ({ item, source: 'Hacker News', title: item.title, build: () => buildHNContent(item) })),
    ...results.github.map(item => ({ item, source: 'GitHub', title: item.fullName, build: () => buildGitHubContent(item) })),
    ...results.arxiv.map(item => ({ item, source: 'arXiv', title: item.title, build: () => buildArxivContent(item) })),
    ...results.ycombinator.map(item => ({ item, source: 'YC', title: item.name, build: () => buildYCContent(item) })),
  ];
  let summarized = 0;
  let errors = 0;
  let skipped = 0;
  for (let i = 0; i < tasks.length; i++) {
    const { item, source, title, build } = tasks[i];
    try {
      const content = await build();
      if (!content || content.length < 40) {
        skipped++;
        console.log(`  ⏭  [${i + 1}/${tasks.length}] ${source}: ${title} (insufficient content)`);
      } else {
        const { whyRead, summary } = await generateSummary({ source, title, content });
        item.aiWhyRead = whyRead;
        item.aiSummary = summary;
        summarized++;
        console.log(`  ✅ [${i + 1}/${tasks.length}] ${source}: ${title}`);
      }
    } catch (err) {
      if (err.fatal) throw err;
      errors++;
      console.warn(`  ⚠️  [${i + 1}/${tasks.length}] ${source}: ${title} — ${err.message}`);
    }
    await sleep(GEMINI_RATE_LIMIT_MS);
  }
  return { total: tasks.length, summarized, errors, skipped };
}

// ── Main ──
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║    tksignal — Data Fetcher v1.0          ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  📅 ${new Date().toISOString()}\n`);
  const [hn, github, yc] = await Promise.all([
    fetchHackerNews().catch(err => { console.error('HN failed:', err.message); return []; }),
    fetchGitHubTrending().catch(err => { console.error('GitHub failed:', err.message); return []; }),
    fetchYCombinator().catch(err => { console.error('YC failed:', err.message); return []; }),
  ]);
  const arxiv = await fetchArxiv().catch(err => { console.error('arXiv failed:', err.message); return []; });
  const results = {
    hackerNews: hn,
    github: github,
    arxiv: arxiv,
    ycombinator: yc,
    meta: {
      fetchedAt: new Date().toISOString(),
      version: '1.0.0',
      counts: {
        hackerNews: hn.length,
        github: github.length,
        arxiv: arxiv.length,
        ycombinator: yc.length,
      },
    },
  };

  if (GEMINI_API_KEY) {
    console.log('\n✨ Generating AI summaries with Gemini...');
    const llm = await summarizeAll(results);
    results.meta.llm = {
      provider: 'google-gemini',
      model: GEMINI_MODEL,
      summarizedAt: new Date().toISOString(),
      ...llm,
    };
  } else {
    console.log('\n⚠️  No GEMINI_API_KEY set — skipping AI summaries. Set the env var to enable them.');
    results.meta.llm = { provider: null, enabled: false };
  }
  writeFileSync(
    join(DATA_DIR, 'feed.json'),
    JSON.stringify(results, null, 2),
    'utf-8'
  );
  console.log('\n────────────────────────────────────');
  console.log('📊 Summary:');
  console.log(`  🔥 Hacker News:  ${hn.length} stories`);
  console.log(`  ⭐ GitHub:       ${github.length} repos`);
  console.log(`  📚 arXiv:        ${arxiv.length} papers`);
  console.log(`  🚀 YC Startups:  ${yc.length} launches`);
  console.log(`\n✅ Data written to ${join(DATA_DIR, 'feed.json')}`);
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
