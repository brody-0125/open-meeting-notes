// Separate process: product-wide resolver rules must not affect the positive control.
import { app, BrowserWindow, protocol, session } from 'electron';
app.setPath('userData', process.env.OMN_APP_TEST_DIRECTORY);
app.commandLine.appendSwitch('disable-background-networking');
protocol.registerSchemesAsPrivileged([{ scheme: 'omn', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.whenReady().then(async () => {
  protocol.handle('omn', () => new Response('<title>Same-host positive control</title>', { headers: { 'content-type': 'text/html' } }));
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(true));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('omn://app/control');
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
