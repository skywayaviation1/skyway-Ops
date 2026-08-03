// MxProjections.jsx - Maintenance projections view for MAINT tab
// Self-contained; drop into MaintScreen as a sub-view.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { db } from './firebase.js';
import {
  collection, getDocs, doc, setDoc,
} from 'firebase/firestore';
import {
  Wrench, Upload, RefreshCw, Calendar, Plane, Filter,
} from 'lucide-react';
import {
  computeProjection, projectionBadge, fmtProjectedDate,
  computeAvgHoursFromTrips, computeAvgLandingsFromTrips,
  sortByProjection, formatRemaining, CATEGORY_STYLES,
} from './mx-utils.js';
import { notify } from './ui.jsx';

const FLEET_TAILS = [
  'N168ZZ', 'N20UF', 'N286N', 'N444AM', 'N525CR',
  'N551FP', 'N651TW', 'N72MM', 'N85AH',
];

export default function MxProjections({ currentUser, allTrips = [] }) {
  const [selectedTail, setSelectedTail] = useState('N168ZZ');
  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('all');

  const isAuthorized = ['ops', 'admin', 'maint'].includes(currentUser?.role);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'mxDueItems'));
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error('Load items failed:', e);
    }
    setLoading(false);
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'mxProjectionSettings'));
      const loaded = {};
      snap.docs.forEach(d => { loaded[d.id] = d.data(); });
      setSettings(loaded);
    } catch (e) {
      console.error('Load settings failed:', e);
    }
  }, []);

  useEffect(() => {
    if (!isAuthorized) return;
    loadItems();
    loadSettings();
  }, [isAuthorized, loadItems, loadSettings]);

  const autoCalc = useCallback(async () => {
    const avgHours = computeAvgHoursFromTrips(allTrips, selectedTail, 90);
    const avgLandings = computeAvgLandingsFromTrips(allTrips, selectedTail, 90);
    if (avgHours == null && avgLandings == null) {
      notify.error(`No trip data found for ${selectedTail} in the last 90 days. Enter values manually.`);
      return;
    }
    const current = settings[selectedTail] || {};
    const newSettings = {
      ...current,
      ...(avgHours != null && { avgHoursPerMonth: avgHours }),
      ...(avgLandings != null && { avgLandingsPerMonth: avgLandings }),
      autoCalculatedAt: new Date().toISOString(),
    };
    await setDoc(doc(db, 'mxProjectionSettings', selectedTail), newSettings);
    setSettings(prev => ({ ...prev, [selectedTail]: newSettings }));
  }, [allTrips, selectedTail, settings]);

  const saveSetting = useCallback(async (field, value) => {
    const parsed = value === '' ? null : parseFloat(value);
    if (parsed != null && (isNaN(parsed) || parsed < 0)) return;
    const current = settings[selectedTail] || {};
    const newSettings = { ...current, [field]: parsed };
    await setDoc(doc(db, 'mxProjectionSettings', selectedTail), newSettings);
    setSettings(prev => ({ ...prev, [selectedTail]: newSettings }));
  }, [selectedTail, settings]);

  const handlePdfUpload = useCallback(async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadStatus('Reading PDF...');
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      setUploadStatus('Parsing with Claude (this can take 30-90 seconds for a full fleet PDF)...');
      const res = await fetch('/api/mx-due-list-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64: base64, filename: file.name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setUploadStatus(`✓ Imported ${json.count} items across ${json.tails?.length || 0} tail(s): ${json.tails?.join(', ') || ''}`);
      await loadItems();
    } catch (e) {
      console.error('PDF upload failed:', e);
      setUploadStatus(`Error: ${e.message}`);
    }
    setUploading(false);
    setTimeout(() => setUploadStatus(null), 12000);
  }, [loadItems]);

  // Items for selected tail with projections
  const displayItems = useMemo(() => {
    const tailSettings = settings[selectedTail] || {};
    const tailItems = items.filter(i => i.tail === selectedTail);
    const withProjections = tailItems.map(item => ({
      ...item,
      projection: computeProjection(item, tailSettings),
    }));
    const sorted = sortByProjection(withProjections);
    if (categoryFilter === 'all') return sorted;
    return sorted.filter(i => (i.categoryType || '').includes(categoryFilter));
  }, [items, settings, selectedTail, categoryFilter]);

  const summary = useMemo(() => {
    const bands = { overdue: 0, d30: 0, d90: 0, d180: 0, later: 0 };
    displayItems.forEach(i => {
      if (!i.projection) return;
      const d = i.projection.daysUntilDue;
      if (d < 0) bands.overdue++;
      else if (d < 30) bands.d30++;
      else if (d < 90) bands.d90++;
      else if (d < 180) bands.d180++;
      else bands.later++;
    });
    return bands;
  }, [displayItems]);

  const tailCounts = useMemo(() => {
    const counts = {};
    FLEET_TAILS.forEach(t => { counts[t] = 0; });
    items.forEach(i => { if (counts[i.tail] != null) counts[i.tail]++; });
    return counts;
  }, [items]);

  const currentTailSettings = settings[selectedTail] || {};

  if (!isAuthorized) {
    return (
      <div className="p-6 text-center text-gray-500">
        Access restricted to ops, maint, and admin.
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Wrench className="w-5 h-5" /> Maintenance Projections
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Projects when items come due based on avg hours/landings flown.
          </p>
        </div>
        <label
          className={`cursor-pointer inline-flex items-center gap-2 px-4 py-2 rounded text-white ${
            uploading ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'
          }`}
        >
          <Upload className="w-4 h-4" />
          {uploading ? 'Parsing…' : 'Upload Veryon PDF'}
          <input
            type="file" accept="application/pdf"
            className="hidden"
            onChange={e => handlePdfUpload(e.target.files?.[0])}
            disabled={uploading}
          />
        </label>
      </div>

      {uploadStatus && (
        <div
          className={`p-3 rounded text-sm ${
            uploadStatus.startsWith('Error')
              ? 'bg-red-50 text-red-700 border border-red-200'
              : uploadStatus.startsWith('✓')
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-blue-50 text-blue-700 border border-blue-200'
          }`}
        >
          {uploadStatus}
        </div>
      )}

      {/* Tail selector */}
      <div className="flex flex-wrap gap-2">
        {FLEET_TAILS.map(tail => (
          <button
            key={tail}
            onClick={() => setSelectedTail(tail)}
            className={`px-3 py-1.5 rounded-full text-sm font-mono border ${
              selectedTail === tail
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-700 border-gray-300 hover:border-blue-400'
            }`}
          >
            {tail} <span className="opacity-70">({tailCounts[tail] || 0})</span>
          </button>
        ))}
      </div>

      {/* Utilization + Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border rounded p-4 bg-gray-50">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold flex items-center gap-2">
              <Plane className="w-4 h-4" /> Utilization – {selectedTail}
            </h3>
            <button
              onClick={autoCalc}
              className="text-xs px-2 py-1 bg-white border rounded hover:bg-blue-50 inline-flex items-center gap-1"
              title="Recompute from trips over the last 90 days"
            >
              <RefreshCw className="w-3 h-3" /> Auto-calc from last 90d
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                Avg flight hours / month
              </label>
              <input
                type="number"
                value={currentTailSettings.avgHoursPerMonth ?? ''}
                onChange={e => saveSetting('avgHoursPerMonth', e.target.value)}
                placeholder="e.g. 40"
                className="w-full px-2 py-1 border rounded"
                step="0.1"
                min="0"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                Avg landings / month
              </label>
              <input
                type="number"
                value={currentTailSettings.avgLandingsPerMonth ?? ''}
                onChange={e => saveSetting('avgLandingsPerMonth', e.target.value)}
                placeholder="e.g. 30"
                className="w-full px-2 py-1 border rounded"
                step="0.1"
                min="0"
              />
            </div>
          </div>
          {currentTailSettings.autoCalculatedAt && (
            <p className="text-xs text-gray-500 mt-2">
              Last auto-calc: {new Date(currentTailSettings.autoCalculatedAt).toLocaleString()}
            </p>
          )}
          <p className="text-xs text-gray-500 mt-2">
            Leave blank to project on calendar constraints only.
          </p>
        </div>

        <div className="border rounded p-4">
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <Calendar className="w-4 h-4" /> Coming Due – {selectedTail}
          </h3>
          <div className="grid grid-cols-5 gap-2 text-center">
            <SummaryChip label="Overdue" count={summary.overdue} color="bg-red-600 text-white" />
            <SummaryChip label="< 30d" count={summary.d30} color="bg-red-400 text-white" />
            <SummaryChip label="< 90d" count={summary.d90} color="bg-orange-400 text-white" />
            <SummaryChip label="< 180d" count={summary.d180} color="bg-yellow-300 text-yellow-900" />
            <SummaryChip label="Later" count={summary.later} color="bg-green-300 text-green-900" />
          </div>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2 text-sm">
        <Filter className="w-4 h-4 text-gray-500" />
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="border rounded px-2 py-1"
        >
          <option value="all">All categories</option>
          <option value="INSPECTION">Inspections</option>
          <option value="AD">Airworthiness Directives</option>
          <option value="PART">Parts (Life-Limited / Overhaul)</option>
          <option value="SB">Service Bulletins</option>
          <option value="MAINTENANCE">Maintenance</option>
        </select>
        <span className="text-gray-500 ml-auto">
          {displayItems.length} item{displayItems.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Items table */}
      <div className="border rounded overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : displayItems.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No items for {selectedTail}. Upload a Veryon Due List PDF to import.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-100 text-xs uppercase text-gray-600">
              <tr>
                <th className="text-left px-3 py-2">ATA / Item</th>
                <th className="text-left px-3 py-2">Description</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Remaining</th>
                <th className="text-left px-3 py-2">Projected Due</th>
                <th className="text-left px-3 py-2">Urgency</th>
              </tr>
            </thead>
            <tbody>
              {displayItems.map(item => {
                const badge = projectionBadge(item.projection?.daysUntilDue);
                const catStyle = CATEGORY_STYLES[item.categoryType] || CATEGORY_STYLES['INSPECTION'];
                return (
                  <tr key={item.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                      <div className="font-semibold">{item.ata || '—'}</div>
                      <div className="text-gray-500">#{item.itemId}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs text-gray-800">{item.description}</div>
                      {item.component && item.component !== 'Airframe' && (
                        <div className="text-xs text-gray-500 mt-0.5">{item.component}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${catStyle.badge}`}>
                        {catStyle.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {formatRemaining(item.remaining)}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {item.projection ? (
                        <>
                          <div>{fmtProjectedDate(item.projection.dueDate)}</div>
                          <div className="text-gray-500">via {item.projection.source}</div>
                        </>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-block px-2 py-1 rounded text-xs font-bold ${badge.color}`}>
                        {badge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SummaryChip({ label, count, color }) {
  return (
    <div className={`rounded p-2 ${color}`}>
      <div className="text-lg font-bold">{count}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}
