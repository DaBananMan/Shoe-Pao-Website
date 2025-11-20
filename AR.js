// NOTE: We avoid a top-level static import of '@snap/camera-kit' because
// browsers serving ES modules from a static site cannot resolve bare
// specifiers like '@snap/camera-kit' without a bundler or import map.
// Instead we lazily attempt to load the package at runtime (dynamic import)
// and fall back to trying a UMD bundle injected via a <script> tag.

// Configuration (replace these with your real values if needed)
const AR_API_TOKEN = 'eyJhbGciOiJIUzI1NiIsImtpZCI6IkNhbnZhc1MyU0hNQUNQcm9kIiwidHlwIjoiSldUIn0.eyJhdWQiOiJjYW52YXMtY2FudmFzYXBpIiwiaXNzIjoiY2FudmFzLXMyc3Rva2VuIiwibmJmIjoxNzYzNTE2MDY3LCJzdWIiOiI2MTk0ZWUzNi0zZTVjLTQwODMtOWRkYy0zNzIzYTdjY2U0OGJ-U1RBR0lOR341NmU2NzFmNC04YTg3LTRkMzAtODQ3ZC1mOTg0YTFjNTkzNGIifQ.kt8hfIKsMUUI80dqpfUaHa-NgyagEdZQzd1s1-BAays'
const AR_GROUP_ID = '9a8350d1-1048-407b-94e5-1e740fe90deb'

// Keep reference to active session and stream so we can stop later
window._shoePaoAR = window._shoePaoAR || { session: null, stream: null }

// Attempt to load the CameraKit package in a few ways:
// 1) dynamic import('@snap/camera-kit') — works if your environment supports bare specifiers (import maps/bundlers)
// 2) check for UMD globals on window (if a script bundle was injected)
// 3) try injecting a CDN UMD script (best-effort; may or may not exist for this package)
async function loadScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = url
        s.async = true
        s.onload = () => resolve()
        s.onerror = (e) => reject(new Error('Script load error: ' + url))
        document.head.appendChild(s)
    })
}

async function loadCameraKit(){
    // 1) try dynamic import (may fail in browsers without an import map / bundler)
    try{
        const mod = await import('@snap/camera-kit')
        return mod
    }catch(err){
        console.warn('Dynamic import of @snap/camera-kit failed:', err)
    }

    // 2) check for UMD-style globals (some bundles expose bootstrapCameraKit on window)
    if (window.bootstrapCameraKit && window.createMediaStreamSource) {
        return {
            bootstrapCameraKit: window.bootstrapCameraKit,
            createMediaStreamSource: window.createMediaStreamSource,
            Transform2D: window.Transform2D || {}
        }
    }

    // 3) try known CDN UMD paths (best-effort). You may need to host a UMD build yourself.
        // First check for a local build produced by the Rollup script (dist/ar.umd.js)
        const localDist = './dist/ar.umd.js'
        try{
            await loadScript(localDist)
            if (window.bootstrapCameraKit && window.createMediaStreamSource) {
                return {
                    bootstrapCameraKit: window.bootstrapCameraKit,
                    createMediaStreamSource: window.createMediaStreamSource,
                    Transform2D: window.Transform2D || {}
                }
            }
        }catch(e){
            console.warn('Local dist load failed for', localDist, e)
        }

        const cdnCandidates = [
            'https://unpkg.com/@snap/camera-kit/dist/camera-kit.umd.js',
            'https://cdn.jsdelivr.net/npm/@snap/camera-kit/dist/camera-kit.umd.js'
        ]
    for(const url of cdnCandidates){
        try{
            await loadScript(url)
            if (window.bootstrapCameraKit && window.createMediaStreamSource) {
                return {
                    bootstrapCameraKit: window.bootstrapCameraKit,
                    createMediaStreamSource: window.createMediaStreamSource,
                    Transform2D: window.Transform2D || {}
                }
            }
        }catch(e){
            console.warn('CDN load attempt failed for', url, e)
        }
    }

    // nothing worked
    return null
}

/**
 * Start a CameraKit session and attach the live output to the provided container.
 * @param {Element|string|null} container - DOM element or selector to place the live output. If null, appends to document.body.
 * @param {Object} options - optional settings { cameraType: 'front'|'back', mirror: boolean }
 */
async function startARSession(container, options) {
    options = options || {}
    const cameraType = options.cameraType || 'back'
    const mirror = (typeof options.mirror === 'boolean') ? options.mirror : (cameraType === 'front')

    // if there's already a running session, reuse it
    if (window._shoePaoAR.session) {
        return window._shoePaoAR.session
    }

        // Lazy-load camera-kit. This keeps the module free of static imports so
        // browsers won't attempt to resolve bare specifiers at module-eval time.
        const cameraKitModule = await loadCameraKit()
        if (!cameraKitModule || !cameraKitModule.bootstrapCameraKit) {
            throw new Error('CameraKit not available. Ensure @snap/camera-kit is bundled or available via a UMD script.')
        }
        const { bootstrapCameraKit, createMediaStreamSource, Transform2D } = cameraKitModule

        const cameraKit = await bootstrapCameraKit({ apiToken: AR_API_TOKEN })
    const session = await cameraKit.createSession()

    // determine container element
    let el = null
    if (container) {
        if (typeof container === 'string') el = document.querySelector(container)
        else el = container
    }
    if (el && session && session.output && session.output.live) {
        // replace container contents with live output
        // if the provided element itself is a placeholder element, replace it
        try { el.replaceWith(session.output.live) } catch (e) { el.appendChild(session.output.live) }
    } else if (session && session.output && session.output.live) {
        document.body.appendChild(session.output.live)
    }

    // load lenses and apply first lens in the group
    try {
        const { lenses } = await cameraKit.lensRepository.loadLensGroups([AR_GROUP_ID])
        if (Array.isArray(lenses) && lenses.length) session.applyLens(lenses[0])
    } catch (e) {
        // non-fatal: lens load may fail if id invalid
        console.warn('Lens load failed', e)
    }

    // request camera stream
    const constraints = (cameraType === 'front') ? { video: { facingMode: 'user' } } : { video: { facingMode: { exact: 'environment' } } }
    let mediaStream = null
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (err) {
        // fallback to generic video if facingMode exact failed
        mediaStream = await navigator.mediaDevices.getUserMedia({ video: true })
    }

    const srcOpts = {}
    if (mirror) srcOpts.transform = Transform2D && Transform2D.MirrorX
    if (cameraType === 'front') srcOpts.cameraType = 'front'
    else srcOpts.cameraType = 'back'

    const source = createMediaStreamSource(mediaStream, srcOpts)
    await session.setSource(source)

    // set render size if available
    try { if (session.source && typeof session.source.setRenderSize === 'function') session.source.setRenderSize(window.innerWidth, window.innerHeight) } catch (e) {}

    session.play()

    // store references
    window._shoePaoAR.session = session
    window._shoePaoAR.stream = mediaStream

    return session
}

/** Stop the active AR session and release camera. */
async function stopARSession(){
    try{
        if(window._shoePaoAR && window._shoePaoAR.session){
            try{ window._shoePaoAR.session.pause && window._shoePaoAR.session.pause() }catch(e){}
            window._shoePaoAR.session = null
        }
        if(window._shoePaoAR && window._shoePaoAR.stream){
            window._shoePaoAR.stream.getTracks().forEach(t=>t.stop())
            window._shoePaoAR.stream = null
        }
    }catch(e){ console.warn('stopARSession error', e) }
}

// expose globally
window.startARSession = startARSession
window.stopARSession = stopARSession

export { startARSession, stopARSession }