import * as db from './db.js';
import { exportEntries, buildCsvText } from './log.js';

function $(id) { return document.getElementById(id); }

let currentEntries = [];

function formatRow(e) {
  const time = new Date(e.timestamp).toLocaleTimeString();
  const porosity = e.porosityPct != null ? `${e.porosityPct}%` : '—';
  const top3 = e.top3Mm != null ? `${e.top3Mm} mm` : '—';
  const dia = e.diameterMm != null ? `${e.diameterMm} mm` : '—';
  return `<tr><td>${time}</td><td>${e.grade}</td><td>${porosity}</td><td>${top3}</td><td>${dia}</td></tr>`;
}

async function refreshDateOptions() {
  const select = $('log-date-select');
  const dates = await db.getAllLogDates();
  const today = db.dateKeyFor();
  const allDates = dates.includes(today) ? dates : [today, ...dates];
  const previousValue = select.value;
  select.innerHTML = allDates.map((d) => `<option value="${d}">${d}</option>`).join('');
  select.value = allDates.includes(previousValue) ? previousValue : today;
}

async function refreshTable() {
  const dateKey = $('log-date-select').value;
  currentEntries = dateKey ? await db.getLogForDate(dateKey) : [];
  currentEntries.sort((a, b) => a.timestamp - b.timestamp);
  $('log-table-body').innerHTML = currentEntries.map(formatRow).join('');
  $('log-count').textContent = `${currentEntries.length} disk${currentEntries.length === 1 ? '' : 's'}`;
}

async function refreshAll() {
  await refreshDateOptions();
  await refreshTable();
}

function setExportStatus(text) { $('export-status').textContent = text; }

async function handleExport(entries, filenamePrefix) {
  if (entries.length === 0) {
    setExportStatus('Nothing to export for this selection.');
    return;
  }
  setExportStatus('Preparing export…');
  const { result, filename } = await exportEntries(entries, filenamePrefix);
  if (result === 'share') setExportStatus(`Shared ${filename}.`);
  else if (result === 'download') setExportStatus(`Downloaded ${filename}. If it didn't save properly, use "View as text" below.`);
  else setExportStatus(`Could not save the file directly. Use "View as text" below instead.`);
}

export async function initLogTab() {
  $('log-date-select').addEventListener('change', refreshTable);

  $('btn-export-day').addEventListener('click', () => {
    const dateKey = $('log-date-select').value;
    handleExport(currentEntries, `cork-log-${dateKey}`);
  });

  $('btn-export-all').addEventListener('click', async () => {
    const all = await db.getAllLogEntries();
    all.sort((a, b) => a.timestamp - b.timestamp);
    handleExport(all, 'cork-log-all');
  });

  $('btn-view-text').addEventListener('click', () => {
    $('text-export-area').value = buildCsvText(currentEntries);
    $('text-export-modal').hidden = false;
  });
  $('btn-close-text-export').addEventListener('click', () => { $('text-export-modal').hidden = true; });

  window.addEventListener('tab-shown', (e) => {
    if (e.detail.tab === 'log') refreshAll();
  });

  await refreshAll();
}
