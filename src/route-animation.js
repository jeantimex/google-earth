const DEFAULT_TOUR_CAMERA_ALTITUDE_MODE = "ABSOLUTE";

function getCoordinate(latLng) {
  let lat = 0;
  let lng = 0;

  if (latLng) {
    if (typeof latLng.lat === "function") {
      lat = latLng.lat();
    } else if (typeof latLng.lat === "number") {
      lat = latLng.lat;
    } else if (typeof latLng.latitude === "function") {
      lat = latLng.latitude();
    } else if (typeof latLng.latitude === "number") {
      lat = latLng.latitude;
    }

    if (typeof latLng.lng === "function") {
      lng = latLng.lng();
    } else if (typeof latLng.lng === "number") {
      lng = latLng.lng;
    } else if (typeof latLng.longitude === "function") {
      lng = latLng.longitude();
    } else if (typeof latLng.longitude === "number") {
      lng = latLng.longitude;
    }
  }

  return { lat, lng };
}

function getHaversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getHeading(lat1, lng1, lat2, lng2) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;

  const y = Math.sin(dLng) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);

  const brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360;
}

function interpolateHeading(current, target, lerpFactor) {
  let diff = target - current;
  while (diff < -180) diff += 360;
  while (diff > 180) diff -= 360;
  return (current + diff * lerpFactor + 360) % 360;
}

function getTimeAdjustedLerpFactor(frameLerpFactor, dt) {
  return 1 - Math.pow(1 - frameLerpFactor, dt * 60);
}

function precomputePathDistances(path) {
  const pathDistances = [0];
  let totalPathDistance = 0;

  for (let i = 1; i < path.length; i++) {
    const p1 = getCoordinate(path[i - 1]);
    const p2 = getCoordinate(path[i]);
    const dist = getHaversineDistance(p1.lat, p1.lng, p2.lat, p2.lng);
    totalPathDistance += dist;
    pathDistances.push(totalPathDistance);
  }

  return { pathDistances, totalPathDistance };
}

const defaultRouteTourOptions = {
  getSpeedMPS: () => 20,
  getViewType: () => "fp",
  getCameraAltitudeMode: () => DEFAULT_TOUR_CAMERA_ALTITUDE_MODE,
  getTourHeightOffset: () => 10,
  getSuspension: () => 90,
  getTurnSmoothness: () => 97,
  getChaseDistance: () => 50,
  getChaseHeadingOffset: () => 0,
  getChaseTilt: () => 65
};

export class RouteTourAnimation {
  constructor({ mapElement = null, options = {}, onStateChange = null } = {}) {
    this.mapElement = mapElement;
    this.options = { ...defaultRouteTourOptions, ...options };
    this.onStateChange = onStateChange;

    this.path = null;
    this.elevations = [];
    this.pathDistances = [];
    this.totalPathDistance = 0;
    this.lockedBaseAltitude = 0;

    this.isTouring = false;
    this.progress = 0;
    this.animationId = null;
    this.smoothCameraCenter = null;
    this.smoothHeading = null;
    this.smoothTilt = null;
    this.smoothRange = null;
    this.lastFrameTime = null;
  }

  setMapElement(mapElement) {
    this.mapElement = mapElement;
  }

  setOptions(options = {}) {
    this.options = { ...this.options, ...options };
  }

  setRoute({ path, elevations = [], baseAltitude = 0 }) {
    this.path = path || null;
    this.elevations = elevations;
    this.lockedBaseAltitude = baseAltitude;

    if (this.path?.length >= 2) {
      const distanceData = precomputePathDistances(this.path);
      this.pathDistances = distanceData.pathDistances;
      this.totalPathDistance = distanceData.totalPathDistance;
    } else {
      this.pathDistances = [];
      this.totalPathDistance = 0;
    }
  }

  clearRoute({ stopCamera = true } = {}) {
    this.stop({ stopCamera });
    this.path = null;
    this.elevations = [];
    this.pathDistances = [];
    this.totalPathDistance = 0;
    this.progress = 0;
  }

  canStart() {
    return Boolean(this.mapElement && this.path?.length >= 2 && this.pathDistances.length >= 2);
  }

  getState() {
    if (!this.isTouring) return "stopped";
    return this.animationId ? "touring" : "aligning";
  }

  getProgress() {
    return {
      distance: this.progress,
      totalDistance: this.totalPathDistance,
      ratio: this.totalPathDistance > 0 ? this.progress / this.totalPathDistance : 0
    };
  }

  start({ baseAltitude = this.lockedBaseAltitude } = {}) {
    if (!this.canStart()) return false;

    this.mapElement.stopCameraAnimation();
    this.isTouring = true;
    this.progress = 0;
    this.lockedBaseAltitude = baseAltitude;
    this.smoothCameraCenter = null;
    this.smoothHeading = null;
    this.smoothTilt = null;
    this.smoothRange = null;
    this.lastFrameTime = null;

    this.onStateChange?.("aligning");

    const p1 = getCoordinate(this.path[0]);
    const p2 = getCoordinate(this.path[1]);
    const startSample = this.getRouteSampleAtDistance(0);
    const startHeading = getHeading(p1.lat, p1.lng, p2.lat, p2.lng);
    const viewType = this.options.getViewType();
    const cameraAltMode = this.options.getCameraAltitudeMode();
    const tourBaseAltitude = this.getTourBaseAltitude(startSample, cameraAltMode);
    const tourHeightOffset = this.options.getTourHeightOffset(viewType);

    let targetTilt = 80;
    let targetRange = 0.1;
    let targetHeading = startHeading;
    const targetCenter = {
      lat: p1.lat,
      lng: p1.lng,
      altitude: tourBaseAltitude + tourHeightOffset
    };

    if (viewType === "tp") {
      targetTilt = this.options.getChaseTilt();
      targetRange = this.options.getChaseDistance();
      targetHeading = (startHeading + this.options.getChaseHeadingOffset() + 360) % 360;
    }

    this.mapElement.flyCameraTo({
      endCamera: {
        center: targetCenter,
        heading: targetHeading,
        tilt: targetTilt,
        range: targetRange,
        altitudeMode: cameraAltMode
      },
      durationMillis: 3000
    });

    const onAlignComplete = () => {
      if (!this.isTouring) return;

      this.onStateChange?.("touring");
      this.smoothCameraCenter = { ...targetCenter };
      this.smoothHeading = targetHeading;
      this.smoothTilt = targetTilt;
      this.smoothRange = targetRange;
      this.animationId = requestAnimationFrame((timestamp) => this.animate(timestamp));
    };

    this.mapElement.addEventListener("gmp-animationend", onAlignComplete, { once: true });
    return true;
  }

  stop({ stopCamera = true } = {}) {
    this.isTouring = false;

    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    this.smoothCameraCenter = null;
    this.smoothHeading = null;
    this.smoothTilt = null;
    this.smoothRange = null;
    this.lastFrameTime = null;

    if (stopCamera && this.mapElement) {
      this.mapElement.stopCameraAnimation();
    }

    this.onStateChange?.("stopped");
  }

  getRouteSampleAtDistance(progress) {
    let targetProgress = progress;
    if (targetProgress >= this.totalPathDistance) {
      targetProgress = this.totalPathDistance;
    }
    if (targetProgress < 0) {
      targetProgress = 0;
    }

    let idx = 0;
    while (idx < this.pathDistances.length - 2 && this.pathDistances[idx + 1] < targetProgress) {
      idx++;
    }

    const segmentDist = this.pathDistances[idx + 1] - this.pathDistances[idx];
    const distInSegment = targetProgress - this.pathDistances[idx];
    const frac = segmentDist > 0 ? distInSegment / segmentDist : 0;

    const p1 = getCoordinate(this.path[idx]);
    const p2 = getCoordinate(this.path[idx + 1] || this.path[idx]);
    const altitude1 = this.elevations[idx] ?? 0;
    const altitude2 = this.elevations[idx + 1] ?? altitude1;

    return {
      lat: p1.lat + (p2.lat - p1.lat) * frac,
      lng: p1.lng + (p2.lng - p1.lng) * frac,
      altitude: altitude1 + (altitude2 - altitude1) * frac
    };
  }

  getPositionAtDistance(progress) {
    const sample = this.getRouteSampleAtDistance(progress);
    return { lat: sample.lat, lng: sample.lng };
  }

  getTourBaseAltitude(routeSample, cameraAltMode) {
    if (cameraAltMode === "ABSOLUTE") {
      return routeSample.altitude ?? 0;
    }

    return this.lockedBaseAltitude ?? 0;
  }

  getTargetHeading(lat, lng, speedMPS, dt) {
    const lookAheadDistance = Math.max(speedMPS * dt * 25, 25);

    if (this.progress + lookAheadDistance < this.totalPathDistance) {
      const aheadPos = this.getPositionAtDistance(this.progress + lookAheadDistance);
      return getHeading(lat, lng, aheadPos.lat, aheadPos.lng);
    }

    const pEnd = getCoordinate(this.path[this.path.length - 1]);
    const pPenultimate = getCoordinate(this.path[this.path.length - 2]);
    return getHeading(pPenultimate.lat, pPenultimate.lng, pEnd.lat, pEnd.lng);
  }

  animate(timestamp) {
    if (!this.isTouring || !this.canStart()) {
      this.stop();
      return;
    }

    if (!timestamp) timestamp = performance.now();
    if (this.lastFrameTime === null) {
      this.lastFrameTime = timestamp;
      this.animationId = requestAnimationFrame((nextTimestamp) => this.animate(nextTimestamp));
      return;
    }

    const dt = Math.min((timestamp - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = timestamp;

    const speedMPS = this.options.getSpeedMPS();
    this.progress += speedMPS * dt;

    let reachedEnd = false;
    if (this.progress >= this.totalPathDistance) {
      this.progress = this.totalPathDistance;
      reachedEnd = true;
    }

    const currentSample = this.getRouteSampleAtDistance(this.progress);
    const lat = currentSample.lat;
    const lng = currentSample.lng;
    const targetHeading = this.getTargetHeading(lat, lng, speedMPS, dt);

    const viewType = this.options.getViewType();
    const cameraAltMode = this.options.getCameraAltitudeMode();
    const baseAltitude = this.getTourBaseAltitude(currentSample, cameraAltMode);
    const targetAltitude = baseAltitude + this.options.getTourHeightOffset(viewType);
    let targetTilt = 80;
    let targetRange = 0.1;
    let finalTargetHeading = targetHeading;

    if (viewType === "tp") {
      targetTilt = this.options.getChaseTilt();
      targetRange = this.options.getChaseDistance();
      finalTargetHeading = (targetHeading + this.options.getChaseHeadingOffset() + 360) % 360;
    }

    const suspensionVal = this.options.getSuspension();
    const frameK = Math.max(1.0 - (suspensionVal / 100), 0.02);
    const k = getTimeAdjustedLerpFactor(frameK, dt);

    const turnSmoothnessVal = this.options.getTurnSmoothness();
    const frameKHeading = Math.max(1.0 - (turnSmoothnessVal / 100), 0.01);
    const kHeading = getTimeAdjustedLerpFactor(frameKHeading, dt);
    const kAltitude = getTimeAdjustedLerpFactor(0.08, dt);

    let cameraAltitude = targetAltitude;

    if (this.smoothCameraCenter === null) {
      this.smoothCameraCenter = { lat, lng, altitude: targetAltitude };
      this.smoothHeading = finalTargetHeading;
      this.smoothTilt = targetTilt;
      this.smoothRange = targetRange;
    } else {
      cameraAltitude = this.smoothCameraCenter.altitude + (targetAltitude - this.smoothCameraCenter.altitude) * kAltitude;
      this.smoothCameraCenter = { lat, lng, altitude: cameraAltitude };
      this.smoothHeading = interpolateHeading(this.smoothHeading, finalTargetHeading, kHeading);
      this.smoothTilt += (targetTilt - this.smoothTilt) * k;
      this.smoothRange += (targetRange - this.smoothRange) * k;
    }

    this.mapElement.flyCameraTo({
      endCamera: {
        center: this.smoothCameraCenter,
        heading: this.smoothHeading,
        tilt: this.smoothTilt,
        range: this.smoothRange,
        altitudeMode: cameraAltMode
      },
      durationMillis: 0
    });

    if (reachedEnd && this.hasConverged(lat, lng, targetAltitude, finalTargetHeading, cameraAltMode)) {
      this.stop();
      return;
    }

    this.animationId = requestAnimationFrame((nextTimestamp) => this.animate(nextTimestamp));
  }

  hasConverged(lat, lng, targetAltitude, finalTargetHeading, cameraAltMode) {
    const horizontalDist = getHaversineDistance(this.smoothCameraCenter.lat, this.smoothCameraCenter.lng, lat, lng);
    const altDiff = Math.abs(this.smoothCameraCenter.altitude - targetAltitude);
    let headingDiff = Math.abs(this.smoothHeading - finalTargetHeading);
    if (headingDiff > 180) headingDiff = 360 - headingDiff;

    if (horizontalDist >= 0.1 || altDiff >= 0.1 || headingDiff >= 0.5) {
      return false;
    }

    this.smoothCameraCenter.lat = lat;
    this.smoothCameraCenter.lng = lng;
    this.smoothCameraCenter.altitude = targetAltitude;
    this.smoothHeading = finalTargetHeading;

    this.mapElement.flyCameraTo({
      endCamera: {
        center: this.smoothCameraCenter,
        heading: this.smoothHeading,
        tilt: this.smoothTilt,
        range: this.smoothRange,
        altitudeMode: cameraAltMode
      },
      durationMillis: 0
    });

    return true;
  }
}

export {
  DEFAULT_TOUR_CAMERA_ALTITUDE_MODE,
  getCoordinate,
  getHaversineDistance,
  getHeading,
  precomputePathDistances
};
