import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import prisma from './db.js';
import { parseJobHtml } from './parsers/index.js';
import { scoreJobs, rescoreAllLeads } from './services/scoring.js';
import { enrichCompany, searchCompanies } from './services/companiesHouse.js';
import { initScheduler, getStats, runDailySummary } from './services/scheduler.js';
import { performDiscoverySweep } from './services/discovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = join(__dirname, '..', '..', 'uploads');
if (!existsSync(uploadsDir)) {
  mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const leadDir = join(uploadsDir, req.params.leadId || 'general');
    if (!existsSync(leadDir)) {
      mkdirSync(leadDir, { recursive: true });
    }
    cb(null, leadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${timestamp}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DOC, DOCX, TXT, and MD files are allowed.'));
    }
  }
});

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Large limit for HTML ingestion

// Seed built-in sources on startup
async function seedBuiltinSources() {
  const builtins = [
    { name: 'LinkedIn', url: 'https://www.linkedin.com/jobs', builtin: true, enabled: true },
    { name: 'Indeed', url: 'https://uk.indeed.com', builtin: true, enabled: true },
    { name: 'Otta', url: 'https://otta.com', builtin: true, enabled: true },
    { name: 'Greenhouse', url: 'https://boards.greenhouse.io', builtin: true, enabled: true },
    { name: 'Lever', url: 'https://jobs.lever.co', builtin: true, enabled: true },
    { name: 'Ashby', url: 'https://jobs.ashbyhq.com', builtin: true, enabled: true },
    { name: 'Rippling', url: 'https://ats.rippling.com', builtin: true, enabled: true },
  ];
  for (const src of builtins) {
    const existing = await prisma.jobSource.findUnique({ where: { name: src.name } });
    if (!existing) {
      await prisma.jobSource.create({ data: src });
    }
  }
}
seedBuiltinSources().catch(console.error);

// Root route
app.get('/', (req, res) => {
  res.json({
    name: 'FrogHunter API',
    version: '1.0.0',
    endpoints: ['/api/health', '/api/leads', '/api/radar-zones', '/api/sources', '/api/stats']
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Radar Zones API
app.get('/api/radar-zones', async (req, res) => {
  try {
    const zones = await prisma.radarZone.findMany({
      orderBy: { createdAt: 'desc' }
    });
    // Parse JSON strings back to arrays
    const parsed = zones.map(z => ({
      ...z,
      greenFlags: JSON.parse(z.greenFlags || '[]'),
      redFlags: JSON.parse(z.redFlags || '[]'),
      enabledSources: JSON.parse(z.enabledSources || '[]'),
      trackedBoards: JSON.parse(z.trackedBoards || '{}')
    }));
    res.json(parsed);
  } catch (error) {
    console.error('Error fetching radar zones:', error);
    res.status(500).json({ error: 'Failed to fetch radar zones' });
  }
});

app.post('/api/radar-zones', async (req, res) => {
  try {
    const { name, searchTitle, searchLocation, greenFlags, redFlags, enabledSources, trackedBoards, active } = req.body;
    const zone = await prisma.radarZone.create({
      data: {
        name,
        searchTitle: searchTitle || '',
        searchLocation: searchLocation || '',
        greenFlags: JSON.stringify(greenFlags || []),
        redFlags: JSON.stringify(redFlags || []),
        enabledSources: JSON.stringify(enabledSources || ['LinkedIn', 'Indeed']),
        trackedBoards: JSON.stringify(trackedBoards || {}),
        active: active ?? true
      }
    });
    res.json({
      ...zone,
      greenFlags: JSON.parse(zone.greenFlags),
      redFlags: JSON.parse(zone.redFlags),
      enabledSources: JSON.parse(zone.enabledSources),
      trackedBoards: JSON.parse(zone.trackedBoards)
    });
  } catch (error) {
    console.error('Error creating radar zone:', error);
    res.status(500).json({ error: 'Failed to create radar zone' });
  }
});

app.patch('/api/radar-zones/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, searchTitle, searchLocation, greenFlags, redFlags, enabledSources, trackedBoards, active } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (searchTitle !== undefined) data.searchTitle = searchTitle;
    if (searchLocation !== undefined) data.searchLocation = searchLocation;
    if (greenFlags !== undefined) data.greenFlags = JSON.stringify(greenFlags);
    if (redFlags !== undefined) data.redFlags = JSON.stringify(redFlags);
    if (enabledSources !== undefined) data.enabledSources = JSON.stringify(enabledSources);
    if (trackedBoards !== undefined) data.trackedBoards = JSON.stringify(trackedBoards);
    if (active !== undefined) data.active = active;

    const zone = await prisma.radarZone.update({
      where: { id },
      data
    });
    res.json({
      ...zone,
      greenFlags: JSON.parse(zone.greenFlags),
      redFlags: JSON.parse(zone.redFlags),
      enabledSources: JSON.parse(zone.enabledSources),
      trackedBoards: JSON.parse(zone.trackedBoards || '{}')
    });
  } catch (error) {
    console.error('Error updating radar zone:', error);
    res.status(500).json({ error: 'Failed to update radar zone' });
  }
});

app.delete('/api/radar-zones/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.radarZone.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting radar zone:', error);
    res.status(500).json({ error: 'Failed to delete radar zone' });
  }
});

// Job Sources API
app.get('/api/sources', async (req, res) => {
  try {
    const sources = await prisma.jobSource.findMany({
      orderBy: [{ builtin: 'desc' }, { name: 'asc' }]
    });
    res.json(sources);
  } catch (error) {
    console.error('Error fetching sources:', error);
    res.status(500).json({ error: 'Failed to fetch sources' });
  }
});

app.post('/api/sources', async (req, res) => {
  try {
    const { name, url, enabled } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Source name is required' });
    }
    const source = await prisma.jobSource.create({
      data: {
        name: name.trim(),
        url: url || '',
        enabled: enabled ?? true,
        builtin: false,
      }
    });
    res.json(source);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'A source with that name already exists' });
    }
    console.error('Error creating source:', error);
    res.status(500).json({ error: 'Failed to create source' });
  }
});

app.patch('/api/sources/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, url, enabled } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (url !== undefined) data.url = url;
    if (enabled !== undefined) data.enabled = enabled;

    const source = await prisma.jobSource.update({
      where: { id },
      data
    });
    res.json(source);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'A source with that name already exists' });
    }
    console.error('Error updating source:', error);
    res.status(500).json({ error: 'Failed to update source' });
  }
});

app.delete('/api/sources/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const source = await prisma.jobSource.findUnique({ where: { id } });
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    if (source.builtin) {
      return res.status(400).json({ error: 'Cannot delete built-in sources. Disable it instead.' });
    }
    await prisma.jobSource.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting source:', error);
    res.status(500).json({ error: 'Failed to delete source' });
  }
});

// Radar Ingestion API
app.post('/api/radar/ingest', async (req, res) => {
  try {
    const { rawHtml, source = 'auto' } = req.body;

    if (!rawHtml) {
      return res.status(400).json({ error: 'rawHtml is required' });
    }

    // Parse the HTML to extract job listings
    const parsedJobs = parseJobHtml(rawHtml, source);

    if (parsedJobs.length === 0) {
      return res.json({
        success: true,
        message: 'No jobs found in the provided HTML',
        stats: { parsed: 0, new: 0, duplicates: 0 }
      });
    }

    // Score the jobs against radar zones
    const scoredJobs = await scoreJobs(parsedJobs);

    // Save jobs to database, skipping duplicates
    let newCount = 0;
    let duplicateCount = 0;
    const savedLeads = [];

    for (const job of scoredJobs) {
      try {
        // Check if job already exists by URL
        const existing = await prisma.jobLead.findUnique({
          where: { jobUrl: job.jobUrl }
        });

        if (existing) {
          duplicateCount++;
          continue;
        }

        // Create new job lead
        const lead = await prisma.jobLead.create({
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
        savedLeads.push(lead);
        newCount++;
      } catch (err) {
        // Handle unique constraint violations
        if (err.code === 'P2002') {
          duplicateCount++;
        } else {
          console.error('Error saving lead:', err);
        }
      }
    }

    res.json({
      success: true,
      stats: {
        parsed: parsedJobs.length,
        new: newCount,
        duplicates: duplicateCount
      },
      leads: savedLeads
    });
  } catch (error) {
    console.error('Error ingesting jobs:', error);
    res.status(500).json({ error: 'Failed to ingest jobs' });
  }
});

// Rescore all leads (call after updating radar zones)
app.post('/api/radar/rescore', async (req, res) => {
  try {
    const count = await rescoreAllLeads();
    res.json({ success: true, rescored: count });
  } catch (error) {
    console.error('Error rescoring leads:', error);
    res.status(500).json({ error: 'Failed to rescore leads' });
  }
});

// Run automated discovery sweep
app.post('/api/radar/sweep', async (req, res) => {
  // Allow up to 10 minutes for discovery sweeps
  req.setTimeout(600000);
  res.setTimeout(600000);
  try {
    const stats = await performDiscoverySweep();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error running discovery sweep:', error);
    res.status(500).json({ error: 'Failed to run discovery sweep' });
  }
});

// Job Leads API
app.get('/api/leads', async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? { status } : {};
    const leads = await prisma.jobLead.findMany({
      where,
      orderBy: { matchScore: 'desc' },
      include: { company: true }
    });
    res.json(leads);
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

app.post('/api/leads', async (req, res) => {
  try {
    const lead = await prisma.jobLead.create({
      data: req.body
    });
    res.json(lead);
  } catch (error) {
    console.error('Error creating lead:', error);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await prisma.jobLead.update({
      where: { id },
      data: req.body
    });
    res.json(lead);
  } catch (error) {
    console.error('Error updating lead:', error);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.jobLead.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting lead:', error);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

// Company Profiles API
app.get('/api/companies', async (req, res) => {
  try {
    const companies = await prisma.companyProfile.findMany({
      orderBy: { companyName: 'asc' },
      include: { jobLeads: true }
    });
    res.json(companies);
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

app.get('/api/companies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const company = await prisma.companyProfile.findUnique({
      where: { id },
      include: { jobLeads: true }
    });
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json(company);
  } catch (error) {
    console.error('Error fetching company:', error);
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

app.patch('/api/companies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const company = await prisma.companyProfile.update({
      where: { id },
      data: req.body
    });
    res.json(company);
  } catch (error) {
    console.error('Error updating company:', error);
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// Companies House Integration
app.get('/api/companies-house/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Query parameter q is required' });
    }
    const results = await searchCompanies(q);
    res.json(results);
  } catch (error) {
    console.error('Error searching Companies House:', error);
    res.status(500).json({ error: 'Failed to search Companies House' });
  }
});

app.post('/api/companies/:id/enrich', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the company profile
    const company = await prisma.companyProfile.findUnique({ where: { id } });
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Enrich from Companies House
    const enriched = await enrichCompany(company.companyName);

    if (!enriched.found) {
      return res.json({ success: false, message: enriched.message });
    }

    // Update the company profile
    const updated = await prisma.companyProfile.update({
      where: { id },
      data: {
        companiesHouseId: enriched.companiesHouseId,
        industry: enriched.industry,
        size: enriched.size,
        notes: company.notes
          ? company.notes + '\n\n---\nCompanies House: ' + JSON.stringify(enriched, null, 2)
          : 'Companies House: ' + JSON.stringify(enriched, null, 2)
      }
    });

    res.json({ success: true, company: updated, enriched });
  } catch (error) {
    console.error('Error enriching company:', error);
    res.status(500).json({ error: 'Failed to enrich company' });
  }
});

// Enrich company for a specific lead
app.post('/api/leads/:id/enrich-company', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the lead
    const lead = await prisma.jobLead.findUnique({ where: { id } });
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Enrich from Companies House
    const enriched = await enrichCompany(lead.companyName);

    if (!enriched.found) {
      return res.json({ success: false, message: enriched.message });
    }

    // Create or update company profile
    let company = await prisma.companyProfile.findUnique({
      where: { companyName: lead.companyName }
    });

    if (company) {
      company = await prisma.companyProfile.update({
        where: { id: company.id },
        data: {
          companiesHouseId: enriched.companiesHouseId,
          industry: enriched.industry,
          size: enriched.size,
        }
      });
    } else {
      company = await prisma.companyProfile.create({
        data: {
          companyName: lead.companyName,
          companiesHouseId: enriched.companiesHouseId,
          industry: enriched.industry,
          size: enriched.size,
        }
      });
    }

    // Link lead to company
    await prisma.jobLead.update({
      where: { id },
      data: { companyId: company.id }
    });

    res.json({ success: true, company, enriched });
  } catch (error) {
    console.error('Error enriching company for lead:', error);
    res.status(500).json({ error: 'Failed to enrich company' });
  }
});

// File Uploads API
app.post('/api/leads/:leadId/files', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { leadId } = req.params;
    const { type } = req.body; // 'cv', 'cover_letter', 'notes', etc.

    // Verify lead exists
    const lead = await prisma.jobLead.findUnique({ where: { id: leadId } });
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json({
      success: true,
      file: {
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        type: type || 'document',
        path: `/uploads/${leadId}/${req.file.filename}`
      }
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Stats API
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.post('/api/stats/daily-summary', async (req, res) => {
  try {
    const stats = await runDailySummary();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error running daily summary:', error);
    res.status(500).json({ error: 'Failed to run daily summary' });
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

const server = app.listen(PORT, () => {
  console.log(`🐸 FrogHunter API running on http://localhost:${PORT}`);
  initScheduler();
});

// Allow long-running requests (e.g. discovery sweeps) up to 10 minutes
server.timeout = 600000;
server.keepAliveTimeout = 600000;
server.headersTimeout = 605000;
