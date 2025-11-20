import { bootstrapCameraKit, createMediaStreamSource, Transform2D } from '@snap/camera-kit'

// Expose camera-kit helpers on window so AR.js loadCameraKit can detect them
window.bootstrapCameraKit = bootstrapCameraKit
window.createMediaStreamSource = createMediaStreamSource
window.Transform2D = Transform2D

// Also attach a grouped object for convenience
window.ShoePaoCameraKit = {
  bootstrapCameraKit,
  createMediaStreamSource,
  Transform2D
}

export default window.ShoePaoCameraKit
