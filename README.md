# Web App to Android Studio Project

A small browser-based tool that takes a zipped web app and turns it into a complete, ready-to-open Android Studio project. The output wraps your app in a WebView, serves it from local assets instead of a live URL, and comes with working file downloads and file picking out of the box.

Everything runs client-side. You drop in a zip, fill in a couple of fields, and get back a project zip you can unpack and open directly in Android Studio.

## Why this exists

Wrapping a web app in a WebView sounds simple until you actually try it. You end up dealing with asset loading and CORS issues, downloads that silently fail because blob and data URLs don't trigger the normal Android download flow, file inputs that don't open a picker, and a manifest and Gradle setup you have to get right every time.

This tool handles all of that for you. It generates a project that:

- Serves your web app from `https://appassets.androidplatform.net/assets/www/` using `WebViewAssetLoader`, so relative paths and `fetch()` calls work the way they do on a real server, without CORS problems.
- Intercepts downloads, whether triggered by `<a download>`, blob URLs, data URLs, or a server response, and routes them through Android's native "Save As" dialog.
- Supports `<input type="file">` elements by opening the system file picker.
- Handles Android's back button by going back in web history first, then exiting.
- Ships with a sensible manifest, Gradle wrapper, and launcher icon so the project builds immediately.

## How to use it

1. Open `index.html` in a browser.
2. Drag in a zip of your web app, or click the drop zone to browse for one. The zip needs an `index.html` somewhere inside it; the tool finds the shallowest one and treats its folder as the web root.
3. Fill in the app name and package name (for example `com.example.mywebapp`). The package name is validated as you type.
4. Optionally set the minimum Android version, upload an icon, toggle internet access and cleartext HTTP, and check off any runtime permissions your app needs (camera, microphone, location, storage, and so on).
5. Click **Generate project**. The tool unpacks your zip in the browser, builds the Android project files around it, and gives you a zip to download.
6. Unzip the result, open it in Android Studio with **Open**, and let Gradle sync.

## What's inside the generated project

```
app/
  src/main/
    assets/www/          your web app, copied as-is
    java/.../MainActivity.java
    res/                  manifest strings, colors, theme, launcher icons
    AndroidManifest.xml
  build.gradle
gradle/wrapper/
gradlew, gradlew.bat
settings.gradle
build.gradle
```

The project targets `compileSdk 34`, uses AGP 8.6.0 and Gradle 8.7, and depends only on `androidx.appcompat` and `androidx.webkit`. No Kotlin, no third-party SDKs.

### MainActivity, briefly

`MainActivity.java` sets up the WebView with JavaScript, DOM storage, and wide viewport support enabled, wires in the asset loader, and installs three pieces of native glue:

- A `DownloadListener` for normal HTTP(S) downloads, which streams the remote file into wherever the user chooses to save it.
- A JavaScript interface plus an injected content script that intercepts `<a download>` clicks and blob/data URLs, converts them to base64, and hands them to the native save flow.
- A `WebChromeClient` override for `onShowFileChooser` that opens Android's document picker and returns the selected file to the page.

Both save paths go through `ACTION_CREATE_DOCUMENT`, so the user always gets a native save dialog rather than a silent write to app storage.

## Notes and limitations

- This is a WebView wrapper, not a native rewrite. Anything your web app can't do in a WebView (certain browser APIs, some hardware access) it still won't be able to do here.
- The launcher icon is a placeholder unless you upload your own image. If you skip it, replace the icon later using Android Studio's Image Asset tool.
- The tool only adds the permissions you check off, plus the internet permission if you leave that toggle on. It doesn't try to guess what your app needs by scanning its code.
- Junk files commonly found in zips (`__MACOSX/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`) are stripped out automatically.
- Package names are checked for valid Java identifiers and reserved keywords, but not checked against the Play Store's actual namespace rules.

## Requirements

- A recent version of Android Studio to open the generated project.
- Nothing beyond a browser to run the generator itself. It pulls in JSZip from a CDN for zip handling.