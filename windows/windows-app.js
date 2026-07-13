// Builds a Visual Studio C# (WPF + WebView2) project (as a zip) that wraps a web app
// in a desktop window. Pure logic, no DOM. Dependencies (JSZip) are injected so this
// runs both in Node tests and in the browser tool.
//
// index.html/.js/.css found in the uploaded zip are embedded straight into the exe as
// resources; everything else (models, textures, data, other folders) ships alongside
// the exe as ordinary files, copied to the build output directory.

(function (root) {
    const CSHARP_KEYWORDS = new Set([
        'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char',
        'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do',
        'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally',
        'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int',
        'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null',
        'object', 'operator', 'out', 'override', 'params', 'private', 'protected',
        'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof',
        'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true',
        'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using',
        'virtual', 'void', 'volatile', 'while'
    ]);

    const JUNK = ['__MACOSX/', '/.DS_Store', '.DS_Store', 'Thumbs.db', '/desktop.ini'];

    // Files with these extensions get compiled into the exe as embedded resources.
    // Everything else accompanies the exe as a normal file on disk.
    const WEB_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.css']);

    const TARGET_FRAMEWORKS = new Set(['net8.0-windows', 'net9.0-windows', 'net10.0-windows']);

    function validateNamespace(ns) {
        if (!ns) return 'Namespace is required.';
        const parts = ns.split('.');
        for (const part of parts) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
                return 'Segment "' + part + '" is not a valid identifier.';
            }
            if (CSHARP_KEYWORDS.has(part)) {
                return 'Segment "' + part + '" is a reserved C# keyword.';
            }
        }
        return null;
    }

    function xmlEscape(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function isJunk(path) {
        if (path.endsWith('/')) return true;
        return JUNK.some(function (marker) {
            return path === marker || path.indexOf(marker) !== -1;
        });
    }

    // Picks the shallowest index.html and returns its directory as the web root.
    function findWebRoot(paths) {
        let best = null;
        let bestDepth = Infinity;
        for (const p of paths) {
            const lower = p.toLowerCase();
            if (lower === 'index.html' || lower.endsWith('/index.html')) {
                const depth = p.split('/').length;
                if (depth < bestDepth) {
                    bestDepth = depth;
                    best = p;
                }
            }
        }
        if (best === null) return null;
        const slash = best.lastIndexOf('/');
        return slash === -1 ? '' : best.slice(0, slash + 1);
    }

    function extOf(path) {
        const dot = path.lastIndexOf('.');
        const slash = path.lastIndexOf('/');
        if (dot === -1 || dot < slash) return '';
        return path.slice(dot).toLowerCase();
    }

    function guid() {
        function seg(n) {
            let s = '';
            for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
            return s;
        }
        const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
        return (seg(8) + '-' + seg(4) + '-4' + seg(3) + '-' + variant + seg(3) + '-' + seg(12)).toUpperCase();
    }

    // Packs one or more PNGs into a single .ico container. Each entry is stored as a
    // PNG-compressed image, which Windows has supported natively since Vista.
    function buildIco(images) {
        const count = images.length;
        const headerSize = 6 + 16 * count;
        let dataSize = 0;
        for (const img of images) dataSize += img.png.length;

        const buf = new Uint8Array(headerSize + dataSize);
        const view = new DataView(buf.buffer);
        view.setUint16(0, 0, true);
        view.setUint16(2, 1, true);
        view.setUint16(4, count, true);

        let offset = headerSize;
        let entryPos = 6;
        for (const img of images) {
            const sizeByte = img.size >= 256 ? 0 : img.size;
            buf[entryPos] = sizeByte;
            buf[entryPos + 1] = sizeByte;
            buf[entryPos + 2] = 0;
            buf[entryPos + 3] = 0;
            view.setUint16(entryPos + 4, 1, true);
            view.setUint16(entryPos + 6, 32, true);
            view.setUint32(entryPos + 8, img.png.length, true);
            view.setUint32(entryPos + 12, offset, true);
            buf.set(img.png, offset);
            offset += img.png.length;
            entryPos += 16;
        }
        return buf;
    }

    function slnFile(ns, projectGuid) {
        const solutionGuid = guid();
        return [
            'Microsoft Visual Studio Solution File, Format Version 12.00',
            '# Visual Studio Version 17',
            'VisualStudioVersion = 17.0.31903.59',
            'MinimumVisualStudioVersion = 10.0.40219.1',
            'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "' + ns + '", "' + ns + '\\' + ns + '.csproj", "{' + projectGuid + '}"',
            'EndProject',
            'Global',
            '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
            '\t\tDebug|Any CPU = Debug|Any CPU',
            '\t\tRelease|Any CPU = Release|Any CPU',
            '\tEndGlobalSection',
            '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
            '\t\t{' + projectGuid + '}.Debug|Any CPU.ActiveCfg = Debug|Any CPU',
            '\t\t{' + projectGuid + '}.Debug|Any CPU.Build.0 = Debug|Any CPU',
            '\t\t{' + projectGuid + '}.Release|Any CPU.ActiveCfg = Release|Any CPU',
            '\t\t{' + projectGuid + '}.Release|Any CPU.Build.0 = Release|Any CPU',
            '\tEndGlobalSection',
            '\tGlobalSection(SolutionProperties) = preSolution',
            '\t\tHideSolutionNode = FALSE',
            '\tEndGlobalSection',
            '\tGlobalSection(ExtensibilityGlobals) = postSolution',
            '\t\tSolutionGuid = {' + solutionGuid + '}',
            '\tEndGlobalSection',
            'EndGlobal',
            ''
        ].join('\r\n');
    }

    function csprojFile(ns, opts, webFiles, hasAssets, hasIcon) {
        const tfm = TARGET_FRAMEWORKS.has(opts.targetFramework) ? opts.targetFramework : 'net8.0-windows';
        const version = (opts.appVersion && opts.appVersion.trim()) ? opts.appVersion.trim() : '1.0.0';

        const lines = [];
        function add(s) { lines.push(s); }

        add('<Project Sdk="Microsoft.NET.Sdk">');
        add('');
        add('  <PropertyGroup>');
        add('    <OutputType>WinExe</OutputType>');
        add('    <TargetFramework>' + tfm + '</TargetFramework>');
        add('    <RootNamespace>' + ns + '</RootNamespace>');
        add('    <AssemblyName>' + ns + '</AssemblyName>');
        add('    <UseWPF>true</UseWPF>');
        add('    <Nullable>enable</Nullable>');
        add('    <ImplicitUsings>enable</ImplicitUsings>');
        add('    <Version>' + xmlEscape(version) + '</Version>');
        if (hasIcon) add('    <ApplicationIcon>Resources\\icon.ico</ApplicationIcon>');
        add('  </PropertyGroup>');
        add('');
        add('  <ItemGroup>');
        add('    <PackageReference Include="Microsoft.Web.WebView2" Version="1.0.*" />');
        add('  </ItemGroup>');

        if (hasIcon) {
            add('');
            add('  <ItemGroup>');
            add('    <None Remove="Resources\\icon.ico" />');
            add('    <Resource Include="Resources\\icon.ico" />');
            add('  </ItemGroup>');
        }

        add('');
        add('  <ItemGroup>');
        add('    <None Remove="Resources\\Web\\**\\*" />');
        for (const f of webFiles) {
            const includePath = 'Resources\\Web\\' + f.relPath.split('/').join('\\');
            add('    <EmbeddedResource Include="' + xmlEscape(includePath) + '">');
            add('      <LogicalName>' + xmlEscape('web/' + f.relPath) + '</LogicalName>');
            add('    </EmbeddedResource>');
        }
        add('  </ItemGroup>');

        if (hasAssets) {
            add('');
            add('  <ItemGroup>');
            add('    <None Remove="AppAssets\\**\\*" />');
            add('    <Content Include="AppAssets\\**\\*">');
            add('      <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>');
            add('    </Content>');
            add('  </ItemGroup>');
        }

        add('');
        add('</Project>');
        return lines.join('\n') + '\n';
    }

    function appXaml(ns) {
        return '<Application x:Class="' + ns + '.App"\n' +
            '             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\n' +
            '             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"\n' +
            '             StartupUri="MainWindow.xaml">\n' +
            '    <Application.Resources>\n' +
            '    </Application.Resources>\n' +
            '</Application>\n';
    }

    function appXamlCs(ns) {
        return 'using System.Windows;\n\n' +
            'namespace ' + ns + '\n' +
            '{\n' +
            '    public partial class App : Application\n' +
            '    {\n' +
            '    }\n' +
            '}\n';
    }

    function mainWindowXaml(ns, opts, hasIcon) {
        const width = opts.windowWidth || 1280;
        const height = opts.windowHeight || 800;
        const resizeMode = opts.resizable === false ? 'CanMinimize' : 'CanResize';
        const windowState = opts.startMaximized ? 'Maximized' : 'Normal';
        const iconAttr = hasIcon ? '\n        Icon="Resources/icon.ico"' : '';

        return '<Window x:Class="' + ns + '.MainWindow"\n' +
            '        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\n' +
            '        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"\n' +
            '        xmlns:wv2="clr-namespace:Microsoft.Web.WebView2.Wpf;assembly=Microsoft.Web.WebView2.Wpf"\n' +
            '        Title="' + xmlEscape(opts.appName) + '"\n' +
            '        Width="' + width + '" Height="' + height + '"\n' +
            '        MinWidth="480" MinHeight="360"\n' +
            '        WindowStartupLocation="CenterScreen"\n' +
            '        ResizeMode="' + resizeMode + '"\n' +
            '        WindowState="' + windowState + '"' + iconAttr + '>\n' +
            '    <Grid>\n' +
            '        <wv2:WebView2 x:Name="WebView" />\n' +
            '    </Grid>\n' +
            '</Window>\n';
    }

    function mainWindowXamlCs(ns, opts) {
        const devTools = opts.devTools !== false;
        const openExternalLinks = opts.openExternalLinks !== false;

        const lines = [];
        function add(s) { lines.push(s); }

        add('using System;');
        add('using System.IO;');
        add('using System.Reflection;');
        add('using System.Windows;');
        add('using Microsoft.Web.WebView2.Core;');
        add('using Microsoft.Web.WebView2.Wpf;');
        add('');
        add('namespace ' + ns);
        add('{');
        add('    public partial class MainWindow : Window');
        add('    {');
        add('        private const string HostName = "app.local";');
        add('        private const string StartUrl = "https://app.local/index.html";');
        add('        private string assetsFolder = string.Empty;');
        add('');
        add('        public MainWindow()');
        add('        {');
        add('            InitializeComponent();');
        add('            Loaded += MainWindow_Loaded;');
        add('        }');
        add('');
        add('        private async void MainWindow_Loaded(object sender, RoutedEventArgs e)');
        add('        {');
        add('            string userDataFolder = Path.Combine(');
        add('                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),');
        add('                "' + ns.replace(/"/g, '') + '", "WebView2");');
        add('            Directory.CreateDirectory(userDataFolder);');
        add('');
        add('            CoreWebView2Environment environment =');
        add('                await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);');
        add('            await WebView.EnsureCoreWebView2Async(environment);');
        add('');
        add('            CoreWebView2 core = WebView.CoreWebView2;');
        add('            core.Settings.AreDevToolsEnabled = ' + (devTools ? 'true' : 'false') + ';');
        add('            core.Settings.AreDefaultContextMenusEnabled = ' + (devTools ? 'true' : 'false') + ';');
        add('            core.Settings.IsStatusBarEnabled = false;');
        add('');
        add('            assetsFolder = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "AppAssets"));');
        add('            Directory.CreateDirectory(assetsFolder);');
        add('');
        add('            // Note: SetVirtualHostNameToFolderMapping is intentionally not used here —');
        add('            // WebView2 does not raise WebResourceRequested for a host that also has a folder');
        add('            // mapping, so index.html/.js/.css (served from embedded resources below) would');
        add('            // never be reached. Loose files are read straight off disk in the handler instead.');
        add('            core.AddWebResourceRequestedFilter(');
        add('                $"https://{HostName}/*", CoreWebView2WebResourceContext.All);');
        add('            core.WebResourceRequested += OnWebResourceRequested;');
        if (openExternalLinks) {
            add('            core.NavigationStarting += OnNavigationStarting;');
        }
        add('');
        add('            core.Navigate(StartUrl);');
        add('        }');
        add('');
        add('        // Serves index.html/.js/.css from the resources embedded in this exe. Anything else');
        add('        // is read from the AppAssets folder that sits next to the exe on disk.');
        add('        private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)');
        add('        {');
        add('            Uri uri;');
        add('            try { uri = new Uri(e.Request.Uri); } catch (UriFormatException) { return; }');
        add('            if (!string.Equals(uri.Host, HostName, StringComparison.OrdinalIgnoreCase)) return;');
        add('');
        add('            string path = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart(\'/\'));');
        add('            if (path.Length == 0) path = "index.html";');
        add('');
        add('            Stream? content = Assembly.GetExecutingAssembly().GetManifestResourceStream("web/" + path);');
        add('            if (content == null)');
        add('            {');
        add('                string diskPath = Path.GetFullPath(Path.Combine(assetsFolder, path.Replace(\'/\', Path.DirectorySeparatorChar)));');
        add('                bool withinAssets = diskPath.StartsWith(assetsFolder + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);');
        add('                if (!withinAssets || !File.Exists(diskPath))');
        add('                {');
        add('                    e.Response = WebView.CoreWebView2.Environment.CreateWebResourceResponse(');
        add('                        null, 404, "Not Found", "");');
        add('                    return;');
        add('                }');
        add('                content = File.OpenRead(diskPath);');
        add('            }');
        add('');
        add('            string headers = "Content-Type: " + ContentTypeFor(path) + "\\r\\nCache-Control: no-cache";');
        add('            e.Response = WebView.CoreWebView2.Environment.CreateWebResourceResponse(');
        add('                content, 200, "OK", headers);');
        add('        }');

        if (openExternalLinks) {
            add('');
            add('        // Keeps the app itself inside this window, but sends http(s) links that point');
            add('        // away from the bundled app out to the user\'s default browser.');
            add('        private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)');
            add('        {');
            add('            Uri uri;');
            add('            try { uri = new Uri(e.Uri); } catch (UriFormatException) { return; }');
            add('            if (string.Equals(uri.Host, HostName, StringComparison.OrdinalIgnoreCase)) return;');
            add('            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return;');
            add('');
            add('            e.Cancel = true;');
            add('            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri)');
            add('            {');
            add('                UseShellExecute = true');
            add('            });');
            add('        }');
        }

        add('');
        add('        private static string ContentTypeFor(string path)');
        add('        {');
        add('            int dot = path.LastIndexOf(\'.\');');
        add('            string ext = dot >= 0 ? path.Substring(dot).ToLowerInvariant() : "";');
        add('            switch (ext)');
        add('            {');
        add('                case ".html":');
        add('                case ".htm":');
        add('                    return "text/html; charset=utf-8";');
        add('                case ".js":');
        add('                case ".mjs":');
        add('                    return "text/javascript; charset=utf-8";');
        add('                case ".css":');
        add('                    return "text/css; charset=utf-8";');
        add('                default:');
        add('                    return "application/octet-stream";');
        add('            }');
        add('        }');
        add('    }');
        add('}');
        return lines.join('\n') + '\n';
    }

    function gitignoreFile() {
        return ['bin/', 'obj/', '.vs/', '*.user', ''].join('\n');
    }

    function readmeFile(ns, opts) {
        const assetNote = opts.hasAssets
            ? 'This project also ships loose files in `AppAssets/` (models, textures, data, etc.). ' +
              'They are copied next to the exe on every build — when you distribute the app, ' +
              'zip up the whole output folder, not just the exe.'
            : 'This project has no additional loose assets — everything the app needs is embedded in the exe.';

        return [
            '# ' + opts.appName,
            '',
            'A Visual Studio C# (WPF) project generated by the Web App to Windows .exe Project tool.',
            'It wraps a web app in a native window using WebView2 and serves ' +
                '`index.html`, JavaScript, and CSS straight from resources embedded in the exe.',
            '',
            '## Build',
            '',
            '1. Open `' + ns + '.sln` in Visual Studio 2022 (with the ".NET desktop development" workload).',
            '2. Let NuGet restore `Microsoft.Web.WebView2` (needs internet on the first restore).',
            '3. Press F5 or build in Release. The [Evergreen WebView2 Runtime]' +
                '(https://developer.microsoft.com/microsoft-edge/webview2/) must be present on the machine ' +
                'that runs the exe — it already ships with Windows 11 and most Windows 10 installs.',
            '',
            assetNote,
            '',
            '## Notes',
            '',
            '- The app window navigates to `https://app.local/index.html`. That hostname is virtual: ' +
                '`index.html`/`.js`/`.css` are served from embedded resources, everything else from `AppAssets/`.',
            '- Relative paths and `fetch()` calls in the web app work the same way they did in the browser, ' +
                'since both embedded and loose files are served from the same virtual origin.',
            '- Downloads and `<input type="file">` pickers use WebView2\'s native dialogs — no extra glue needed.',
            ''
        ].join('\n');
    }

    function buildProjectFiles(opts, webFiles, hasAssets, hasIcon) {
        const ns = opts.namespace;
        const files = {};
        const projectGuid = guid();

        files[ns + '.sln'] = slnFile(ns, projectGuid);
        files[ns + '/' + ns + '.csproj'] = csprojFile(ns, opts, webFiles, hasAssets, hasIcon);
        files[ns + '/App.xaml'] = appXaml(ns);
        files[ns + '/App.xaml.cs'] = appXamlCs(ns);
        files[ns + '/MainWindow.xaml'] = mainWindowXaml(ns, opts, hasIcon);
        files[ns + '/MainWindow.xaml.cs'] = mainWindowXamlCs(ns, opts);
        files[ns + '/.gitignore'] = gitignoreFile();
        files[ns + '/README.md'] = readmeFile(ns, Object.assign({ hasAssets: hasAssets }, opts));
        return files;
    }

    // Main entry. deps: { JSZip }
    async function generateProject(opts, deps) {
        const nsError = validateNamespace(opts.namespace);
        if (nsError) throw new Error(nsError);
        if (!opts.appName || !opts.appName.trim()) throw new Error('App name is required.');

        const JSZip = deps.JSZip;
        const source = await JSZip.loadAsync(opts.zipData);

        const entries = [];
        source.forEach(function (relPath, entry) {
            if (!entry.dir && !isJunk(relPath)) entries.push(relPath);
        });
        if (entries.length === 0) throw new Error('The uploaded zip has no files.');

        const webRoot = findWebRoot(entries);
        if (webRoot === null) {
            throw new Error('No index.html found in the zip. The web app needs an index.html entry point.');
        }

        const webFiles = [];
        const assetFiles = [];
        for (const relPath of entries) {
            if (webRoot && relPath.indexOf(webRoot) !== 0) continue;
            const inner = webRoot ? relPath.slice(webRoot.length) : relPath;
            if (!inner) continue;
            const bytes = await source.file(relPath).async('uint8array');
            if (WEB_EXTENSIONS.has(extOf(inner))) {
                webFiles.push({ relPath: inner, bytes: bytes });
            } else {
                assetFiles.push({ relPath: inner, bytes: bytes });
            }
        }
        if (webFiles.length === 0) throw new Error('No HTML, JS, or CSS files were found to embed.');

        const ns = opts.namespace;
        const hasAssets = assetFiles.length > 0;
        const hasIcon = !!opts.iconIco;

        const out = new JSZip();
        const textFiles = buildProjectFiles(opts, webFiles, hasAssets, hasIcon);
        for (const path in textFiles) out.file(path, textFiles[path]);

        for (const f of webFiles) {
            out.file(ns + '/Resources/Web/' + f.relPath, f.bytes);
        }
        for (const f of assetFiles) {
            out.file(ns + '/AppAssets/' + f.relPath, f.bytes);
        }
        if (hasIcon) {
            out.file(ns + '/Resources/icon.ico', opts.iconIco);
        }

        const entries2 = [];
        out.forEach(function (relPath, entry) {
            if (!entry.dir) entries2.push(relPath);
        });
        entries2.sort();

        const payload = await out.generateAsync({
            type: opts.outputType || 'blob',
            platform: 'UNIX',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });

        return {
            payload: payload,
            webFileCount: webFiles.length,
            assetFileCount: assetFiles.length,
            webRoot: webRoot,
            entries: entries2
        };
    }

    const api = {
        generateProject: generateProject,
        validateNamespace: validateNamespace,
        findWebRoot: findWebRoot,
        buildIco: buildIco,
        buildProjectFiles: buildProjectFiles,
        isJunk: isJunk,
        TARGET_FRAMEWORKS: Array.from(TARGET_FRAMEWORKS)
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.WindowsWrapper = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ---------------------------------------------------------------------------
// DOM glue below. Everything above this line is pure logic (WindowsWrapper),
// runnable in Node with no browser globals. Nothing below here is exercised
// outside a browser.
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined') {

var el = function (id) { return document.getElementById(id); };
var drop = el('drop');
var fileInput = el('file');
var goBtn = el('go');
var logEl = el('log');
var treeEl = el('tree');
var resultEl = el('result');

var ICON_SIZES = [16, 32, 48, 256];

var iconPngDataUrls = null; // { 16: 'data:image/png;base64,...', ... }

function processIcon(file) {
    return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
            try {
                var pngs = {};
                ICON_SIZES.forEach(function (size) {
                    var canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    var ctx = canvas.getContext('2d');
                    var side = Math.min(img.width, img.height);
                    var sx = (img.width - side) / 2;
                    var sy = (img.height - side) / 2;
                    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
                    pngs[size] = canvas.toDataURL('image/png');
                });
                resolve({ pngs: pngs, previewUrl: url });
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = function () { reject(new Error('Could not load that image.')); };
        img.src = url;
    });
}

function dataUrlToUint8Array(dataUrl) {
    var binary = atob(dataUrl.split(',')[1]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

el('iconFile').addEventListener('change', function () {
    var file = this.files[0];
    if (!file) { iconPngDataUrls = null; el('iconPreview').hidden = true; return; }
    processIcon(file).then(function (result) {
        iconPngDataUrls = result.pngs;
        el('iconPreviewImg').src = result.previewUrl;
        el('iconPreviewMeta').textContent = file.name;
        el('iconPreview').hidden = false;
        el('iconFileError').textContent = '';
    }).catch(function (err) {
        iconPngDataUrls = null;
        el('iconPreview').hidden = true;
        el('iconFileError').textContent = err.message || 'Could not process that image.';
    });
});

var selectedFile = null;
var currentUrl = null;

function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function slug(name) {
    return name.toLowerCase().replace(/\.zip$/, '').replace(/[^a-z0-9]+/g, '').replace(/^[0-9]+/, '') || 'webapp';
}

function titleize(name) {
    var base = name.replace(/\.zip$/i, '').replace(/[_-]+/g, ' ').trim();
    if (!base) return 'My Web App';
    return base.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function pascalize(name) {
    var title = titleize(name).replace(/[^A-Za-z0-9 ]+/g, ' ');
    var words = title.split(/\s+/).filter(Boolean);
    var joined = words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join('');
    if (!joined) return 'MyWebApp';
    if (/^[0-9]/.test(joined)) joined = '_' + joined;
    return joined;
}

function setFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
        logReset();
        logLine('Please choose a .zip file.', true);
        return;
    }
    selectedFile = file;
    el('dropIdle').hidden = true;
    el('dropLoaded').hidden = false;
    drop.classList.add('loaded');
    el('fileName').textContent = file.name;
    el('fileMeta').textContent = fmtBytes(file.size);

    if (!el('appName').value) el('appName').value = titleize(file.name);
    if (!el('namespace').value) el('namespace').value = pascalize(file.name);
    validate();
}

drop.addEventListener('click', function () { fileInput.click(); });
fileInput.addEventListener('change', function () { setFile(fileInput.files[0]); });

['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hot'); });
});
['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
        e.preventDefault();
        if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
        drop.classList.remove('hot');
    });
});
drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        setFile(e.dataTransfer.files[0]);
    }
});

function validate() {
    var ns = el('namespace').value.trim();
    var appName = el('appName').value.trim();
    var nsErr = ns ? window.WindowsWrapper.validateNamespace(ns) : null;

    el('namespaceError').textContent = ns && nsErr ? nsErr : '';
    el('namespace').classList.toggle('invalid', !!(ns && nsErr));
    el('appNameError').textContent = '';

    var ready = selectedFile && appName && ns && !nsErr;
    goBtn.disabled = !ready;
    return ready;
}

el('appName').addEventListener('input', validate);
el('namespace').addEventListener('input', validate);

function logReset() { logEl.innerHTML = ''; }
function logLine(text, isError) {
    var line = document.createElement('div');
    line.className = 'line' + (isError ? ' err' : '');
    var mark = document.createElement('span');
    mark.className = 'mark' + (isError ? ' err' : '');
    mark.textContent = isError ? 'x' : '>';
    var body = document.createElement('span');
    body.textContent = text;
    line.appendChild(mark);
    line.appendChild(body);
    logEl.appendChild(line);
}

function renderTree(paths) {
    treeEl.innerHTML = '';
    var tree = {};
    paths.forEach(function (p) {
        var parts = p.split('/');
        var node = tree;
        parts.forEach(function (part, i) {
            var isLeaf = i === parts.length - 1;
            if (!node[part]) node[part] = { __leaf: isLeaf, __children: {} };
            node = node[part].__children;
        });
    });

    var rows = [];
    function walk(node, depth, prefixAsset) {
        var keys = Object.keys(node).sort(function (a, b) {
            var ad = Object.keys(node[a].__children).length > 0;
            var bd = Object.keys(node[b].__children).length > 0;
            if (ad !== bd) return ad ? -1 : 1;
            return a.localeCompare(b);
        });
        keys.forEach(function (key) {
            var entry = node[key];
            var isDir = Object.keys(entry.__children).length > 0;
            var indent = '  '.repeat(depth);
            var asset = prefixAsset || key === 'AppAssets' || key === 'Web';
            var cls = isDir ? 'dir' : (asset ? 'leaf asset' : 'leaf');
            rows.push({ text: indent + (isDir ? key + '/' : key), cls: cls });
            if (isDir) walk(entry.__children, depth + 1, asset);
        });
    }
    walk(tree, 0, false);

    rows.forEach(function (r) {
        var div = document.createElement('div');
        div.className = 'row-t ' + r.cls;
        div.textContent = r.text;
        treeEl.appendChild(div);
    });
}

function reader(file) {
    return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { reject(new Error('Could not read the file.')); };
        r.readAsArrayBuffer(file);
    });
}

function intField(id, fallback) {
    var raw = el(id).value.trim();
    if (!raw) return fallback;
    var n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 200 || n > 8000) return fallback;
    return n;
}

goBtn.addEventListener('click', function () {
    if (!validate()) return;
    goBtn.disabled = true;
    resultEl.classList.remove('show');
    treeEl.innerHTML = '';
    logReset();

    var appName = el('appName').value.trim();
    var namespaceValue = el('namespace').value.trim();

    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }

    logLine('Reading ' + selectedFile.name);

    reader(selectedFile).then(function (buffer) {
        logLine('Unpacking web app and locating index.html');

        var iconIco = null;
        if (iconPngDataUrls) {
            var images = ICON_SIZES.map(function (size) {
                return { size: size, png: dataUrlToUint8Array(iconPngDataUrls[size]) };
            });
            iconIco = window.WindowsWrapper.buildIco(images);
        }

        return window.WindowsWrapper.generateProject({
            zipData: buffer,
            appName: appName,
            namespace: namespaceValue,
            targetFramework: el('targetFramework').value,
            appVersion: el('appVersion').value.trim(),
            windowWidth: intField('windowWidth', 1280),
            windowHeight: intField('windowHeight', 800),
            resizable: el('optResizable').checked,
            startMaximized: el('optMaximized').checked,
            devTools: el('optDevTools').checked,
            openExternalLinks: el('optExternalLinks').checked,
            iconIco: iconIco,
            outputType: 'blob'
        }, {
            JSZip: window.JSZip
        });
    }).then(function (result) {
        var rootLabel = result.webRoot ? result.webRoot : '(zip root)';
        logLine('Web root: ' + rootLabel);
        logLine('Embedded ' + result.webFileCount + ' HTML/JS/CSS file(s) into the exe');
        logLine('Copied ' + result.assetFileCount + ' other file(s) into AppAssets');
        logLine('Wrote solution, project, and MainWindow');
        logLine('Done. ' + result.entries.length + ' files in the project.');

        renderTree(result.entries);

        currentUrl = URL.createObjectURL(result.payload);
        var dl = el('download');
        dl.href = currentUrl;
        dl.download = slug(appName || selectedFile.name) + '-windows.zip';
        el('summary').innerHTML = 'Project ready: <b>' + result.entries.length +
            '</b> files, <b>' + fmtBytes(result.payload.size) + '</b> zipped.';
        resultEl.classList.add('show');
        goBtn.disabled = false;
    }).catch(function (err) {
        logLine(err && err.message ? err.message : 'Something went wrong.', true);
        goBtn.disabled = false;
    });
});

window.addEventListener('beforeunload', function () {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
});

}
