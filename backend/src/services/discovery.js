import prisma from '../db.js';
import { parseJobHtml, parseJobJson } from '../parsers/index.js';
import { scoreJobs } from './scoring.js';
import puppeteer from 'puppeteer';

/**
 * ATS API URL templates — {org} is replaced with the company slug
 */
const ATS_API_URLS = {
  greenhouse: 'https://boards-api.greenhouse.io/v1/boards/{org}/jobs',
  lever: 'https://api.lever.co/v0/postings/{org}',
  ashby: 'https://api.ashbyhq.com/posting-api/job-board/{org}',
  rippling: 'https://ats.rippling.com/api/public/board/{org}/jobs',
};

/**
 * Generate search URLs for different job boards
 */
function generateSearchUrls(title, location, enabledSources) {
    const encodedTitle = encodeURIComponent(title);
    const encodedLocation = encodeURIComponent(location);

    const sources = [];
    const enabled = new Set((enabledSources || []).map(s => s.toLowerCase()));

    // Default to all if none specified (legacy support)
    const useAll = enabled.size === 0;

    if (useAll || enabled.has('linkedin')) {
        sources.push({
            source: 'LinkedIn',
            url: `https://www.linkedin.com/jobs/search/?keywords=${encodedTitle}&location=${encodedLocation}&f_TPR=r604800` // Past week
        });
    }

    if (useAll || enabled.has('indeed')) {
        sources.push({
            source: 'Indeed',
            url: `https://uk.indeed.com/jobs?q=${encodedTitle}&l=${encodedLocation}&fromage=7` // Past week
        });
    }

    if (useAll || enabled.has('otta')) {
        sources.push({
            source: 'Otta',
            url: `https://otta.com/jobs/search/${encodedTitle}-in-${encodedLocation}` // Simple approximation, Otta urls are complex
        });
    }

    // Add custom sources if any
    if (!useAll) {
        // Here we could handle custom URLs if we had a way to store them structure in the future
        // For now we just stick to the known parsers
    }

    return sources;
}

/**
 * Fetch HTML using Puppeteer to handle JS and bot detection
 */
async function fetchHtmlWithPuppeteer(url) {
    let browser = null;
    try {
        console.log(`Launching browser for ${url}...`);
        // Launch headless browser with args to fix Windows crash
        // Try to use system Chrome to avoid bundled Chromium issues
        // Launch settings tailored for environment
        const launchOptions = {
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        };

        // Use system Chrome on Windows to avoid bundled Chromium issues
        if (process.platform === 'win32') {
            launchOptions.channel = 'chrome';
        }

        browser = await puppeteer.launch(launchOptions);

        const page = await browser.newPage();

        // Set a realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Navigate to URL
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Basic scroll to trigger lazy loading
        await page.evaluate(async () => {
            window.scrollBy(0, window.innerHeight);
            await new Promise(resolve => setTimeout(resolve, 1000));
        });

        // Get the full HTML
        const html = await page.content();
        console.log(`Fetched ${html.length} chars via Puppeteer`);

        return html;
    } catch (error) {
        console.error(`Error fetching ${url} with Puppeteer:`, error);
        return null;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

/**
 * Fetch JSON from a public API endpoint (no auth needed for ATS boards)
 * @param {string} url
 * @returns {Promise<object|null>}
 */
async function fetchJsonApi(url) {
    try {
        console.log(`Fetching JSON API: ${url}`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
            console.log(`API returned ${res.status} for ${url}`);
            return null;
        }
        return await res.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error(`Timeout fetching JSON from ${url} (30s)`);
        } else {
            console.error(`Error fetching JSON from ${url}:`, error.message);
        }
        return null;
    }
}

/**
 * Generate ATS API fetch tasks from tracked board configuration
 * @param {Set<string>} enabledSourcesLower - Set of lowercase enabled source names
 * @param {object} trackedBoards - e.g. { greenhouse: ['gitlab'], ashby: ['anthropic'] }
 * @returns {Array<{source: string, org: string, url: string}>}
 */
function generateAtsApiTasks(enabledSourcesLower, trackedBoards) {
    const tasks = [];
    for (const [atsKey, orgs] of Object.entries(trackedBoards)) {
        const key = atsKey.toLowerCase();
        if (!enabledSourcesLower.has(key)) continue;
        const template = ATS_API_URLS[key];
        if (!template) continue;

        const orgList = Array.isArray(orgs) ? orgs : [];
        for (const org of orgList) {
            const slug = org.trim();
            if (!slug) continue;
            // Capitalise source name for display
            const sourceName = key.charAt(0).toUpperCase() + key.slice(1);
            tasks.push({
                source: sourceName,
                org: slug,
                url: template.replace('{org}', encodeURIComponent(slug)),
            });
        }
    }
    return tasks;
}

/**
 * Perform a discovery sweep for all active radar zones
 */
export async function performDiscoverySweep() {
    console.log('Starting automated discovery sweep (Puppeteer)...');

    const activeZones = await prisma.radarZone.findMany({
        where: { active: true }
    });

    let totalProcessed = 0;
    let totalNew = 0;

    for (const zone of activeZones) {
        console.log(`Sweeping for zone: ${zone.name}`);

        let enabledSources = [];
        try {
            enabledSources = JSON.parse(zone.enabledSources || '[]');
        } catch (e) {
            enabledSources = ['LinkedIn', 'Indeed'];
        }

        // --- Search-engine sources (LinkedIn, Indeed, Otta) via Puppeteer ---
        // These require searchTitle and searchLocation
        const hasSearchParams = zone.searchTitle && zone.searchLocation;
        const searchTasks = hasSearchParams
            ? generateSearchUrls(zone.searchTitle, zone.searchLocation, enabledSources)
            : [];

        if (!hasSearchParams && searchTasks.length === 0) {
            console.log(`Zone "${zone.name}": no searchTitle/searchLocation, skipping search-engine sources.`);
        }

        for (const task of searchTasks) {
            const html = await fetchHtmlWithPuppeteer(task.url);

            if (!html) {
                console.log(`Failed to fetch HTML from ${task.source} for zone ${zone.name}`);
                continue;
            }

            const parsedJobs = parseJobHtml(html, task.source);
            console.log(`Parsed ${parsedJobs.length} jobs from ${task.source}`);

            if (parsedJobs.length === 0) continue;

            const scoredJobs = await scoreJobs(parsedJobs);

            for (const job of scoredJobs) {
                totalProcessed++;
                try {
                    const existing = await prisma.jobLead.findUnique({
                        where: { jobUrl: job.jobUrl }
                    });

                    if (existing) continue;

                    await prisma.jobLead.create({
                        data: {
                            title: job.title,
                            companyName: job.companyName,
                            location: job.location || null,
                            jobUrl: job.jobUrl,
                            description: job.description || null,
                            source: job.source,
                            matchScore: job.matchScore,
                            status: 'RADAR_NEW',
                        }
                    });
                    totalNew++;
                } catch (err) {
                    if (err.code !== 'P2002') {
                        console.error('Error saving lead:', err);
                    }
                }
            }
        }

        // --- ATS API sources (Greenhouse, Lever, Ashby, Rippling) via JSON ---
        let trackedBoards = {};
        try {
            trackedBoards = JSON.parse(zone.trackedBoards || '{}');
        } catch (e) {
            trackedBoards = {};
        }

        const enabledLower = new Set(enabledSources.map(s => s.toLowerCase()));
        const atsTasks = generateAtsApiTasks(enabledLower, trackedBoards);

        for (const atsTask of atsTasks) {
            const json = await fetchJsonApi(atsTask.url);
            if (!json) {
                console.log(`Failed to fetch API for ${atsTask.source}/${atsTask.org} in zone ${zone.name}`);
                continue;
            }

            const parsedJobs = parseJobJson(json, atsTask.source, atsTask.org);
            console.log(`Parsed ${parsedJobs.length} jobs from ${atsTask.source} (${atsTask.org})`);

            if (parsedJobs.length === 0) continue;

            const scoredJobs = await scoreJobs(parsedJobs);

            for (const job of scoredJobs) {
                totalProcessed++;
                try {
                    const existing = await prisma.jobLead.findUnique({
                        where: { jobUrl: job.jobUrl }
                    });

                    if (existing) continue;

                    await prisma.jobLead.create({
                        data: {
                            title: job.title,
                            companyName: job.companyName,
                            location: job.location || null,
                            jobUrl: job.jobUrl,
                            description: job.description || null,
                            source: job.source,
                            matchScore: job.matchScore,
                            status: 'RADAR_NEW',
                        }
                    });
                    totalNew++;
                } catch (err) {
                    if (err.code !== 'P2002') {
                        console.error('Error saving lead:', err);
                    }
                }
            }
        }
    }

    console.log(`Discovery sweep complete. Processed ${totalProcessed} jobs, found ${totalNew} new leads.`);
    return { processed: totalProcessed, new: totalNew };
}
