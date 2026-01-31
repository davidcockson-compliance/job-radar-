import { useEffect, useState, useCallback, useMemo } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { Settings, List, Upload, RefreshCw, ExternalLink, Filter, Kanban, BarChart3, Search, Globe } from 'lucide-react'
import { RadarIntake } from './components/RadarIntake'
import { PreviewPanel } from './components/PreviewPanel'
import { PipelineView } from './components/PipelineView'
import { WIBSGenerator } from './components/WIBSGenerator'
import { StatsView } from './components/StatsView'
import { ZonesConfig } from './components/ZonesConfig'
import { SourcesManager } from './components/SourcesManager'
import { FrogIcon } from './components/FrogIcon'

interface JobLead {
  id: string
  title: string
  companyName: string
  location: string | null
  jobUrl: string
  description: string | null
  source: string
  matchScore: number
  status: string
  createdAt: string
}

type ViewMode = 'feed' | 'pipeline' | 'stats' | 'intake'
type StatusFilter = 'all' | 'RADAR_NEW' | 'SHORTLISTED' | 'APPLIED' | 'ARCHIVED'

function App() {
  const [leads, setLeads] = useState<JobLead[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewMode>('feed')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [showPreview, setShowPreview] = useState(false)
  const [showZones, setShowZones] = useState(false)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('RADAR_NEW')
  const [animatingIds, setAnimatingIds] = useState<Set<string>>(new Set())
  const [wibsLead, setWibsLead] = useState<JobLead | null>(null)
  const [showSources, setShowSources] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<string>('all')

  const fetchLeads = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/leads')
      const data = await res.json()
      setLeads(data)
    } catch (err) {
      console.error('Failed to fetch leads:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchLeads()
  }, [fetchLeads])

  // Unique sources from leads for filter chips
  const uniqueSources = useMemo(() => {
    const sources = new Set(leads.map(l => l.source))
    return Array.from(sources).sort()
  }, [leads])

  // Filtered leads based on status and source
  const filteredLeads = useMemo(() => {
    let filtered = leads
    if (statusFilter !== 'all') {
      filtered = filtered.filter(l => l.status === statusFilter)
    }
    if (sourceFilter !== 'all') {
      filtered = filtered.filter(l => l.source === sourceFilter)
    }
    return filtered
  }, [leads, statusFilter, sourceFilter])

  // Currently selected lead
  const selectedLead = filteredLeads[selectedIndex] || null

  // Ensure selected index is valid when leads change
  useEffect(() => {
    if (selectedIndex >= filteredLeads.length) {
      setSelectedIndex(Math.max(0, filteredLeads.length - 1))
    }
  }, [filteredLeads.length, selectedIndex])

  const handleStatusChange = useCallback(async (id: string, newStatus: string) => {
    try {
      await fetch(`/api/leads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      })
      setLeads(prev => prev.map(l => l.id === id ? { ...l, status: newStatus } : l))
    } catch (err) {
      console.error('Failed to update lead:', err)
    }
  }, [])

  const animateAndUpdate = useCallback(async (id: string, newStatus: string) => {
    setAnimatingIds(prev => new Set(prev).add(id))
    await new Promise(resolve => setTimeout(resolve, 300))
    await handleStatusChange(id, newStatus)
    setAnimatingIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [handleStatusChange])

  const handleShortlist = useCallback((lead: JobLead) => {
    if (lead.status !== 'RADAR_NEW') return
    animateAndUpdate(lead.id, 'SHORTLISTED')
  }, [animateAndUpdate])

  const handleArchive = useCallback((lead: JobLead) => {
    if (lead.status !== 'RADAR_NEW') return
    animateAndUpdate(lead.id, 'ARCHIVED')
  }, [animateAndUpdate])

  const handleApply = useCallback((lead: JobLead) => {
    if (lead.status !== 'SHORTLISTED') return
    handleStatusChange(lead.id, 'APPLIED')
  }, [handleStatusChange])

  const handleRunDiscovery = useCallback(async () => {
    setLoading(true)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 600000) // 10 minutes
    try {
      const res = await fetch('/api/radar/sweep', { method: 'POST', signal: controller.signal })
      const data = await res.json()
      if (data.success) {
        alert(`Discovery complete! Processed ${data.stats.processed} jobs, found ${data.stats.new} new leads.`)
        fetchLeads()
      }
    } catch (err: any) {
      console.error('Failed to run discovery:', err)
      if (err.name === 'AbortError') {
        alert('Discovery sweep timed out after 10 minutes. The search may still be running on the server.')
      } else {
        alert('Failed to run discovery sweep.')
      }
    } finally {
      clearTimeout(timeout)
      setLoading(false)
    }
  }, [fetchLeads])

  // Hotkeys - only active in feed view
  const hotkeyOptions = { enabled: view === 'feed' && !showPreview && !wibsLead && !showZones && !showSources }

  // Navigation
  useHotkeys('up, k', (e) => {
    e.preventDefault()
    setSelectedIndex(i => Math.max(0, i - 1))
  }, hotkeyOptions, [filteredLeads.length])

  useHotkeys('down, j', (e) => {
    e.preventDefault()
    setSelectedIndex(i => Math.min(filteredLeads.length - 1, i + 1))
  }, hotkeyOptions, [filteredLeads.length])

  // Actions
  useHotkeys('s', () => {
    if (selectedLead) handleShortlist(selectedLead)
  }, hotkeyOptions, [selectedLead, handleShortlist])

  useHotkeys('x', () => {
    if (selectedLead) handleArchive(selectedLead)
  }, hotkeyOptions, [selectedLead, handleArchive])

  useHotkeys('space', (e) => {
    e.preventDefault()
    if (selectedLead) setShowPreview(true)
  }, hotkeyOptions, [selectedLead])

  useHotkeys('escape', () => {
    setShowPreview(false)
    setWibsLead(null)
    setShowZones(false)
    setShowSources(false)
  }, { enabled: showPreview || !!wibsLead || showZones || showSources })

  useHotkeys('enter, o', () => {
    if (selectedLead) {
      window.open(selectedLead.jobUrl, '_blank')
    }
  }, hotkeyOptions, [selectedLead])

  // Filter shortcuts
  useHotkeys('1', () => setStatusFilter('RADAR_NEW'), hotkeyOptions)
  useHotkeys('2', () => setStatusFilter('SHORTLISTED'), hotkeyOptions)
  useHotkeys('3', () => setStatusFilter('APPLIED'), hotkeyOptions)
  useHotkeys('0', () => setStatusFilter('all'), hotkeyOptions)

  // View shortcuts
  useHotkeys('p', () => setView('pipeline'), { enabled: view !== 'intake' && !showPreview && !wibsLead && !showZones })
  useHotkeys('d', () => setView('stats'), { enabled: view !== 'intake' && !showPreview && !wibsLead && !showZones })

  const getScoreBadgeClass = (score: number) => {
    if (score > 50) return 'bg-emerald-900 text-emerald-300'
    if (score > 0) return 'bg-yellow-900 text-yellow-300'
    return 'bg-red-900 text-red-300'
  }

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'SHORTLISTED': return 'bg-blue-900 text-blue-300'
      case 'APPLIED': return 'bg-purple-900 text-purple-300'
      case 'INTERVIEWING': return 'bg-cyan-900 text-cyan-300'
      case 'ARCHIVED': return 'bg-slate-700 text-slate-400'
      default: return 'bg-slate-700 text-slate-300'
    }
  }

  const statusCounts = useMemo(() => ({
    all: leads.length,
    RADAR_NEW: leads.filter(l => l.status === 'RADAR_NEW').length,
    SHORTLISTED: leads.filter(l => l.status === 'SHORTLISTED').length,
    APPLIED: leads.filter(l => l.status === 'APPLIED').length,
    ARCHIVED: leads.filter(l => l.status === 'ARCHIVED').length,
  }), [leads])

  const pipelineCount = statusCounts.SHORTLISTED + statusCounts.APPLIED +
    leads.filter(l => l.status === 'INTERVIEWING').length

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-700 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FrogIcon className="h-8 w-8 text-emerald-500" />
            <h1 className="text-xl font-bold">FrogHunter</h1>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setView('feed')}
              className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition-colors ${view === 'feed'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
            >
              <List className="h-4 w-4" />
              Feed
              <span className="rounded bg-slate-600 px-1.5 text-xs">{statusCounts.RADAR_NEW}</span>
            </button>
            <button
              onClick={() => setView('pipeline')}
              className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition-colors ${view === 'pipeline'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
            >
              <Kanban className="h-4 w-4" />
              Pipeline
              <span className="rounded bg-slate-600 px-1.5 text-xs">{pipelineCount}</span>
            </button>
            <button
              onClick={() => setView('stats')}
              className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition-colors ${view === 'stats'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
            >
              <BarChart3 className="h-4 w-4" />
              Stats
            </button>
            <button
              onClick={() => setView('intake')}
              className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition-colors ${view === 'intake'
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
            >
              <Upload className="h-4 w-4" />
              Intake
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className={`p-4 ${showPreview && view === 'feed' ? 'mr-[480px]' : ''}`}>
        {view === 'intake' ? (
          <RadarIntake onIngestComplete={() => {
            fetchLeads()
            setView('feed')
          }} />
        ) : view === 'stats' ? (
          <StatsView />
        ) : view === 'pipeline' ? (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Application Pipeline</h2>
              <button
                onClick={fetchLeads}
                className="flex items-center gap-1.5 rounded bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
            <PipelineView
              leads={leads}
              onStatusChange={handleStatusChange}
              onSelectLead={(lead) => {
                const idx = leads.findIndex(l => l.id === lead.id)
                if (idx >= 0) setSelectedIndex(idx)
                setShowPreview(true)
              }}
              onGenerateWIBS={(lead) => setWibsLead(lead)}
            />
          </>
        ) : (
          <>
            {/* Filter bar */}
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Filter className="mr-2 h-4 w-4 text-slate-500" />
                {([
                  { key: 'RADAR_NEW', label: 'New', hotkey: '1' },
                  { key: 'SHORTLISTED', label: 'Shortlisted', hotkey: '2' },
                  { key: 'APPLIED', label: 'Applied', hotkey: '3' },
                  { key: 'all', label: 'All', hotkey: '0' },
                ] as const).map(({ key, label, hotkey }) => (
                  <button
                    key={key}
                    onClick={() => setStatusFilter(key)}
                    className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-sm transition-colors ${statusFilter === key
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                      }`}
                  >
                    {label}
                    <span className={`rounded px-1 text-xs ${statusFilter === key ? 'bg-emerald-700' : 'bg-slate-700'
                      }`}>
                      {statusCounts[key]}
                    </span>
                    <kbd className={`ml-1 rounded px-1 text-xs ${statusFilter === key ? 'bg-emerald-700' : 'bg-slate-700'
                      }`}>
                      {hotkey}
                    </kbd>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRunDiscovery}
                  disabled={loading}
                  className="flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
                >
                  <Search className={`h-3.5 w-3.5 ${loading ? 'animate-pulse' : ''}`} />
                  Run Discovery
                </button>
                <button
                  onClick={fetchLeads}
                  className="flex items-center gap-1.5 rounded bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
                <button
                  onClick={() => setShowSources(true)}
                  className="flex items-center gap-1.5 rounded bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
                >
                  <Globe className="h-3.5 w-3.5" />
                  Sources
                </button>
                <button
                  onClick={() => setShowZones(true)}
                  className="flex items-center gap-1.5 rounded bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
                >
                  <Settings className="h-3.5 w-3.5" />
                  Zones
                </button>
              </div>
            </div>

            {/* Source filter */}
            {uniqueSources.length > 1 && (
              <div className="mb-3 flex items-center gap-1">
                <Globe className="mr-2 h-4 w-4 text-slate-500" />
                <button
                  onClick={() => setSourceFilter('all')}
                  className={`rounded px-2.5 py-1 text-sm transition-colors ${
                    sourceFilter === 'all'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                  }`}
                >
                  All Sources
                </button>
                {uniqueSources.map(source => (
                  <button
                    key={source}
                    onClick={() => setSourceFilter(source)}
                    className={`rounded px-2.5 py-1 text-sm transition-colors ${
                      sourceFilter === source
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                    }`}
                  >
                    {source}
                    <span className={`ml-1.5 rounded px-1 text-xs ${
                      sourceFilter === source ? 'bg-emerald-700' : 'bg-slate-700'
                    }`}>
                      {leads.filter(l => l.source === source && (statusFilter === 'all' || l.status === statusFilter)).length}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Hotkey legend */}
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span><kbd className="rounded bg-slate-800 px-1 font-mono">↑↓</kbd> Navigate</span>
              <span><kbd className="rounded bg-slate-800 px-1 font-mono">S</kbd> Shortlist</span>
              <span><kbd className="rounded bg-slate-800 px-1 font-mono">X</kbd> Archive</span>
              <span><kbd className="rounded bg-slate-800 px-1 font-mono">Space</kbd> Preview</span>
              <span><kbd className="rounded bg-slate-800 px-1 font-mono">Enter</kbd> Open</span>
              <span><kbd className="rounded bg-slate-800 px-1 font-mono">P</kbd> Pipeline</span>
              <span><kbd className="rounded bg-slate-800 px-1 font-mono">D</kbd> Dashboard</span>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
              </div>
            ) : filteredLeads.length === 0 ? (
              <div className="rounded-lg border border-slate-700 bg-slate-800 p-12 text-center">
                <FrogIcon className="mx-auto mb-4 h-12 w-12 text-slate-500" />
                <h3 className="mb-2 text-lg font-medium">
                  {leads.length === 0 ? 'No leads detected' : 'No leads match this filter'}
                </h3>
                <p className="mb-4 text-slate-400">
                  {leads.length === 0
                    ? 'Start by ingesting job listings from LinkedIn or Indeed'
                    : 'Try selecting a different filter'}
                </p>
                {leads.length === 0 && (
                  <button
                    onClick={() => setView('intake')}
                    className="inline-flex items-center gap-2 rounded bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500"
                  >
                    <Upload className="h-4 w-4" />
                    Open Intake
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-slate-700">
                <table className="w-full">
                  <thead className="bg-slate-800 text-left text-xs text-slate-400">
                    <tr>
                      <th className="w-14 px-3 py-2 font-medium">Score</th>
                      <th className="px-3 py-2 font-medium">Title</th>
                      <th className="px-3 py-2 font-medium">Company</th>
                      <th className="hidden px-3 py-2 font-medium lg:table-cell">Location</th>
                      <th className="w-20 px-3 py-2 font-medium">Source</th>
                      <th className="w-24 px-3 py-2 font-medium">Status</th>
                      <th className="w-16 px-3 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/50">
                    {filteredLeads.map((lead, index) => {
                      const isSelected = index === selectedIndex
                      const isAnimating = animatingIds.has(lead.id)

                      return (
                        <tr
                          key={lead.id}
                          className={`cursor-pointer transition-all duration-300 ${isAnimating
                            ? 'translate-x-full opacity-0'
                            : ''
                            } ${isSelected
                              ? 'bg-slate-700/50'
                              : 'hover:bg-slate-800/30'
                            }`}
                          onClick={() => {
                            setSelectedIndex(index)
                            setShowPreview(true)
                          }}
                        >
                          <td className="px-3 py-2">
                            <span className={`inline-flex min-w-[2.5rem] items-center justify-center rounded px-1.5 py-0.5 text-xs font-medium ${getScoreBadgeClass(lead.matchScore)}`}>
                              {lead.matchScore > 0 ? '+' : ''}{lead.matchScore}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-sm truncate max-w-[300px]">{lead.title}</span>
                              <a
                                href={lead.jobUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="flex-shrink-0 text-slate-500 hover:text-emerald-400"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-sm text-slate-300 truncate max-w-[200px]">{lead.companyName}</td>
                          <td className="hidden px-3 py-2 text-sm text-slate-400 truncate max-w-[150px] lg:table-cell">{lead.location || '-'}</td>
                          <td className="px-3 py-2">
                            <span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs">
                              {lead.source}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`rounded px-1.5 py-0.5 text-xs ${getStatusBadgeClass(lead.status)}`}>
                              {lead.status.replace('_', ' ')}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex gap-1">
                              {lead.status === 'RADAR_NEW' && (
                                <>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleShortlist(lead) }}
                                    className="rounded bg-blue-700 px-1.5 py-0.5 text-xs font-medium hover:bg-blue-600"
                                    title="Shortlist (S)"
                                  >
                                    S
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleArchive(lead) }}
                                    className="rounded bg-slate-600 px-1.5 py-0.5 text-xs font-medium hover:bg-slate-500"
                                    title="Archive (X)"
                                  >
                                    X
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>

      {/* Preview Panel */}
      {showPreview && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/20"
            onClick={() => setShowPreview(false)}
          />
          <PreviewPanel
            lead={selectedLead}
            onClose={() => setShowPreview(false)}
            onShortlist={handleShortlist}
            onArchive={handleArchive}
            onApply={handleApply}
          />
        </>
      )}

      {/* WIBS Generator Modal */}
      {wibsLead && (
        <WIBSGenerator
          lead={wibsLead}
          company={null}
          onClose={() => setWibsLead(null)}
        />
      )}

      {/* Zones Config Modal */}
      {showZones && (
        <ZonesConfig
          onClose={() => setShowZones(false)}
          onSave={() => {
            setShowZones(false)
            fetchLeads() // Refresh leads with new scores
          }}
        />
      )}

      {/* Sources Manager Modal */}
      {showSources && (
        <SourcesManager onClose={() => setShowSources(false)} />
      )}
    </div>
  )
}

export default App
