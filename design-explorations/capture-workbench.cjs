const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    useContentSize: true,
    show: false,
    webPreferences: { backgroundThrottling: false },
  })

  await win.loadFile(path.join(__dirname, 'axiom-uml-workbench.html'))
  await new Promise(resolve => setTimeout(resolve, 250))
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(__dirname, 'axiom-uml-workbench.png'), image.toPNG())
  app.quit()
})
