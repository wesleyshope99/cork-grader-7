import * as db from './db.js';
import { initGradeTab } from './grade.js';
import { initLogTab } from './logview.js';

function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      window.dispatchEvent(new CustomEvent('tab-shown', { detail: { tab: btn.dataset.tab } }));
    });
  });
}

async function initStorageBanner() {
  const banner = document.getElementById('storage-banner');
  const persistResult = await db.requestPersistentStorage();
  const estimate = await db.getStorageEstimate();

  if (!persistResult.supported) {
    banner.hidden = false;
    banner.textContent = 'This browser does not support persistent storage requests -- data may be cleared under storage pressure.';
    return;
  }

  if (persistResult.persisted) {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    banner.textContent = 'Storage persistence was not granted by the browser. Data is still saved, but could be evicted if the device runs low on space.';
  }

  if (estimate && estimate.quota) {
    const usedMb = (estimate.usage / 1e6).toFixed(1);
    const quotaMb = (estimate.quota / 1e6).toFixed(0);
    console.log(`[storage] using ${usedMb}MB of ${quotaMb}MB estimated quota`);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}

async function main() {
  initTabs();
  await initStorageBanner();
  await initGradeTab();
  await initLogTab();
  registerServiceWorker();
}

main();
