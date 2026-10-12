// Launch Chromium with WebGPU for the build / measurement scripts, and refuse to continue without
// a real adapter (the sample must be embedded with the same model and dtype the browser uses, on
// the GPU, never Node CPU).
import { chromium } from 'playwright';

export async function launchGpuBrowser({ headed = process.argv.includes('--headed') } = {}) {
  const args = ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--ignore-gpu-blocklist', '--enable-webgpu-developer-features'];
  if (process.platform === 'linux') args.push('--use-angle=vulkan', '--enable-features=Vulkan,UseSkiaRenderer');
  const browser = await chromium.launch({
    headless: !headed,
    channel: process.env.CARREL_CHROME_CHANNEL || undefined,
    executablePath: process.env.CARREL_CHROME || undefined,
    args: headed ? args : [...args, '--headless=new'],
  });
  return browser;
}

export async function requireAdapter(page) {
  const info = await page.evaluate(async () => {
    if (!navigator.gpu) return { ok: false, why: 'navigator.gpu is missing' };
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { ok: false, why: 'requestAdapter() returned null' };
    const i = a.info ?? {};
    return { ok: true, vendor: i.vendor, architecture: i.architecture, description: i.description, limits: { maxBufferSize: a.limits.maxBufferSize, maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize } };
  });
  if (!info.ok) {
    throw new Error(
      `No WebGPU adapter in this headless Chromium (${info.why}).\n` +
        'Run on a machine with a GPU, try --headed, or set CARREL_CHROME to a Chrome/Edge binary with WebGPU.\n' +
        'carrel will not fall back to CPU: the sample must be embedded exactly as the browser does it.',
    );
  }
  const software = /swiftshader|llvmpipe|software|lavapipe/i.test(`${info.vendor} ${info.architecture} ${info.description}`);
  if (software && !process.env.CARREL_ALLOW_SOFTWARE_GPU) {
    throw new Error(
      `The only WebGPU adapter here is a software renderer (${info.vendor} ${info.description}). It works but is far too slow for these models, ` +
        'and a build made on it would not be a fair record of what a real GPU produces. Use a machine with a GPU, or set CARREL_ALLOW_SOFTWARE_GPU=1 to proceed anyway.',
    );
  }
  info.software = software;
  return info;
}
