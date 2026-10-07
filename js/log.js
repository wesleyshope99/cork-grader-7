// Daily log export. Adapted from cork-grader-2/js/log.js -- the file-saving
// strategy (share sheet -> download -> text fallback) is unchanged, since
// that's a platform quirk unrelated to how a disk is graded. The row shape
// changes: no ML confidence/per-grade score breakdown, instead the actual
// measured porosity%/top-3-hole-mm/pore-count that produced the grade.

const XLSX = window.XLSX;

function rowsForEntries(entries) {
  return entries.map((e) => ({
    Date: new Date(e.timestamp).toLocaleDateString(),
    Time: new Date(e.timestamp).toLocaleTimeString(),
    Grade: e.grade,
    'Porosity (%)': e.porosityPct ?? '',
    'Top-3 Hole Avg (mm)': e.top3Mm ?? '',
    'Pores Detected': e.numPores ?? '',
    'Diameter (mm)': e.diameterMm ?? '',
    'Pore porosity (%)': e.porePorosityPct ?? '',
    'Discoloration (%)': e.discolorationPct ?? '',
    'Weighted porosity': e.weighted == null ? '' : (e.weighted ? 'Yes' : 'No'),
    'Sharpening': e.sharpenLevel ? e.sharpenLevel[0].toUpperCase() + e.sharpenLevel.slice(1) : '',
    'Video (px)': e.videoW && e.videoH ? `${e.videoW}x${e.videoH}` : '',
  }));
}

export function buildXlsxBlob(entries) {
  const rows = rowsForEntries(entries);
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Log');
  const arrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function buildCsvText(entries) {
  const rows = rowsForEntries(entries);
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => String(row[h]).replace(/,/g, ';')).join(','));
  }
  return lines.join('\n');
}

/**
 * Try to save/share the given blob as a file. Returns a string describing
 * which path succeeded: 'share' | 'download' | 'failed'.
 */
export async function saveOrShareBlob(blob, filename) {
  if (navigator.canShare && navigator.share) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return 'share';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return 'share';
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'download';
  } catch (err) {
    return 'failed';
  }
}

export async function exportEntries(entries, filenamePrefix) {
  const filename = `${filenamePrefix}.xlsx`;
  const blob = buildXlsxBlob(entries);
  const result = await saveOrShareBlob(blob, filename);
  return { result, csvFallback: buildCsvText(entries), filename };
}
