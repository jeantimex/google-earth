import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

// Coordinate definitions for destinations
const DESTINATIONS = {
  sf: {
    center: { lat: 37.7704, lng: -122.3985, altitude: 1000 },
    tilt: 67.5,
    heading: 0
  },
  nyc: {
    center: { lat: 40.7484, lng: -73.9857, altitude: 100 },
    tilt: 65,
    heading: -60,
    range: 1200
  },
  paris: {
    center: { lat: 48.8584, lng: 2.2945, altitude: 80 },
    tilt: 65,
    heading: 120,
    range: 800
  },
  fuji: {
    center: { lat: 35.3606, lng: 138.7274, altitude: 3776 },
    tilt: 50,
    heading: 45,
    range: 8000
  },
  canyon: {
    center: { lat: 36.0544, lng: -112.1401, altitude: 2000 },
    tilt: 55,
    heading: 30,
    range: 6000
  },
  sydney: {
    center: { lat: -33.8568, lng: 151.2153, altitude: 50 },
    tilt: 65,
    heading: 240,
    range: 1000
  }
};

const ROUTE_STROKE_COLOR = "#0b57d0";
const ROUTE_STROKE_WIDTH = 18;
const TURN_MARKER_SCALE = 0.5;
const APPROX_MAP3D_VERTICAL_FOV_DEGREES = 45;

let mapElement = null;
let currentDestKey = "sf";
let isOrbiting = false;
let isTransitioning = false;
let activePolyline = null;
let activeTurnMarkers = [];
let lastRoutePath = null; // Stored path coordinate lat/lng points to support dynamic redraws
let lastTurnPoints = [];   // Stored route turn coordinates for live marker redraws
let turnMarkerRedrawId = null;
let pathDistances = [];   // Cumulative distances along route segments in meters
let totalPathDistance = 0; // Total length of route in meters
let isTouring = false;
let tourProgress = 0;      // Distance progress in meters
let tourAnimationId = null;
let currentTourHeading = null;
let smoothCameraCenter = null;
let smoothHeading = null;
let smoothTilt = null;
let smoothRange = null;
let lastFrameTime = null;

// Autocomplete States
const autocompleteState = {
  origin: {
    input: null,
    suggestionsEl: null,
    sessionToken: null,
    selectedPlace: null,
    debounceId: null
  },
  destination: {
    input: null,
    suggestionsEl: null,
    sessionToken: null,
    selectedPlace: null,
    debounceId: null
  }
};

// DOM Elements
const container = document.getElementById("map-container");
const spinner = document.getElementById("loading-spinner");
const selectDestination = document.getElementById("select-destination");
const btnOrbit = document.getElementById("btn-orbit");
const btnStop = document.getElementById("btn-stop");
const selectMode = document.getElementById("select-mode");

// Route UI Elements
const btnDrawRoute = document.getElementById("btn-draw-route");
const btnClearRoute = document.getElementById("btn-clear-route");
const selectPolyAltMode = document.getElementById("select-poly-alt-mode");
const selectPolyAltVal = document.getElementById("select-poly-alt-val");
const btnTour = document.getElementById("btn-tour");
const rangeTourSpeed = document.getElementById("range-tour-speed");
const labelTourSpeed = document.getElementById("label-tour-speed");
const selectTourView = document.getElementById("select-tour-view");
const rangeTourAltitude = document.getElementById("range-tour-altitude");
const labelTourAltitude = document.getElementById("label-tour-altitude");
const rangeCameraSuspension = document.getElementById("range-camera-suspension");
const labelCameraSuspension = document.getElementById("label-camera-suspension");
const rangeTurnSmoothness = document.getElementById("range-turn-smoothness");
const labelTurnSmoothness = document.getElementById("label-turn-smoothness");

const chaseCamSettings = document.getElementById("chase-cam-settings");
const rangeChaseDistance = document.getElementById("range-chase-distance");
const labelChaseDistance = document.getElementById("label-chase-distance");
const rangeChaseHeight = document.getElementById("range-chase-height");
const labelChaseHeight = document.getElementById("label-chase-height");
const rangeChaseHeading = document.getElementById("range-chase-heading");
const labelChaseHeading = document.getElementById("label-chase-heading");
const rangeChaseTilt = document.getElementById("range-chase-tilt");
const labelChaseTilt = document.getElementById("label-chase-tilt");

const apiKey = import.meta.env.VITE_GOOGLE_MAPS_JS_API_KEY;
if (!apiKey) {
  const errorMsg = "Missing VITE_GOOGLE_MAPS_JS_API_KEY. Please specify it in your .env file.";
  console.error(errorMsg);
  if (container) {
    container.innerHTML = `<div style="color: #ff6b6b; padding: 20px; font-family: sans-serif; text-align: center; max-width: 500px; margin: auto;"><h3>Configuration Error</h3><p style="margin-top: 10px; line-height: 1.4;">${errorMsg}</p></div>`;
  }
  if (spinner) spinner.style.opacity = "0";
  throw new Error(errorMsg);
}

// Configure Loader (weekly channel is GA for 3D Maps)
setOptions({
  key: apiKey,
  v: "weekly",
  libraries: ["maps3d", "places", "routes"]
});

async function init() {
  try {
    const { Map3DElement } = await importLibrary("maps3d");
    
    const initialDest = DESTINATIONS[currentDestKey];
    
    // Instantiate 3D Map
    mapElement = new Map3DElement({
      center: initialDest.center,
      tilt: initialDest.tilt,
      heading: initialDest.heading,
      range: initialDest.range,
      mode: selectMode.value || "HYBRID",
    });

    // Remove spinner when map completes its first load
    container.appendChild(mapElement);
    
    setTimeout(() => {
      if (spinner) {
        spinner.style.opacity = "0";
        setTimeout(() => spinner.remove(), 500);
      }
    }, 1500);

    // Initialize Autocomplete Inputs
    setupAutocomplete("origin", "input-origin", "origin-suggestions");
    setupAutocomplete("destination", "input-destination", "destination-suggestions");

    // Bind event listeners
    setupEventListeners();
  } catch (err) {
    console.error("Error loading Map3DElement:", err);
    if (container) {
      container.innerHTML = `<div style="color: #ff6b6b; padding: 20px; font-family: sans-serif; text-align: center; max-width: 500px; margin: auto;"><h3>Initialization Failed</h3><p style="margin-top: 10px; line-height: 1.4;">${err.message}</p></div>`;
    }
  }
}

function setupAutocomplete(field, inputId, suggestionsId) {
  const state = autocompleteState[field];
  state.input = document.getElementById(inputId);
  state.suggestionsEl = document.getElementById(suggestionsId);

  if (!state.input || !state.suggestionsEl) return;

  // Start autocomplete session on input focus
  state.input.addEventListener("focus", async () => {
    const { AutocompleteSessionToken } = await importLibrary("places");
    if (!state.sessionToken) {
      state.sessionToken = new AutocompleteSessionToken();
    }
  });

  // Handle typing suggestions
  state.input.addEventListener("input", () => {
    const query = state.input.value.trim();
    state.selectedPlace = null; // Clear chosen object if they edit the query

    if (state.debounceId) clearTimeout(state.debounceId);

    if (query.length < 2) {
      hideSuggestions(field);
      return;
    }

    state.debounceId = setTimeout(() => {
      fetchSuggestions(field, query);
    }, 250);
  });

  // Hide suggestions with delay to allow clicks to register
  state.input.addEventListener("blur", () => {
    setTimeout(() => hideSuggestions(field), 200);
  });
}

async function fetchSuggestions(field, query) {
  const state = autocompleteState[field];
  try {
    const { AutocompleteSuggestion } = await importLibrary("places");
    const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: query,
      sessionToken: state.sessionToken
    });

    renderSuggestions(field, suggestions || []);
  } catch (err) {
    console.error(`Error fetching autocomplete for ${field}:`, err);
  }
}

function renderSuggestions(field, suggestions) {
  const state = autocompleteState[field];
  state.suggestionsEl.innerHTML = "";

  const filtered = suggestions.filter(s => s.placePrediction);
  if (filtered.length === 0) {
    hideSuggestions(field);
    return;
  }

  filtered.slice(0, 5).forEach(s => {
    const prediction = s.placePrediction;
    const label = prediction.text.text;
    const item = document.createElement("div");
    item.className = "suggestion-item";
    item.innerText = label;

    item.addEventListener("click", () => {
      state.input.value = label;
      state.selectedPlace = prediction.toPlace();
      hideSuggestions(field);
    });

    state.suggestionsEl.appendChild(item);
  });

  state.suggestionsEl.style.display = "block";
}

function hideSuggestions(field) {
  const state = autocompleteState[field];
  if (state.suggestionsEl) {
    state.suggestionsEl.style.display = "none";
  }
}

function setupEventListeners() {
  // Listen for animation events from map element
  mapElement.addEventListener("gmp-animationend", handleAnimationEnd);
  mapElement.addEventListener("gmp-rangechange", scheduleTurnMarkerRedraw);
  mapElement.addEventListener("gmp-tiltchange", scheduleTurnMarkerRedraw);

  // Destination select change listener
  if (selectDestination) {
    selectDestination.addEventListener("change", (e) => {
      const destKey = e.target.value;
      if (destKey && DESTINATIONS[destKey]) {
        flyTo(destKey);
      }
    });
  }

  // Controls
  btnOrbit.addEventListener("click", () => {
    startOrbit();
  });
  
  btnStop.addEventListener("click", () => {
    stopAnimation();
  });

  if (btnTour) {
    btnTour.addEventListener("click", () => {
      if (isTouring) {
        stopTour();
      } else {
        startTour();
      }
    });
  }

  // Map Mode selection
  selectMode.addEventListener("change", (e) => {
    if (mapElement) {
      mapElement.mode = e.target.value;
    }
  });

  // User click on map should stop animation
  mapElement.addEventListener("gmp-click", () => {
    if (isOrbiting || isTransitioning || isTouring) {
      stopAnimation();
    }
  });

  // Route Planning Event Listeners
  btnDrawRoute.addEventListener("click", drawRoute);
  btnClearRoute.addEventListener("click", clearRoute);

  if (rangeTourAltitude && labelTourAltitude) {
    rangeTourAltitude.addEventListener("input", (e) => {
      labelTourAltitude.innerText = `${e.target.value}m`;
    });
  }

  if (rangeCameraSuspension && labelCameraSuspension) {
    rangeCameraSuspension.addEventListener("input", (e) => {
      labelCameraSuspension.innerText = `${e.target.value}%`;
    });
  }

  if (rangeTurnSmoothness && labelTurnSmoothness) {
    rangeTurnSmoothness.addEventListener("input", (e) => {
      labelTurnSmoothness.innerText = `${e.target.value}%`;
    });
  }

  if (rangeTourSpeed && labelTourSpeed) {
    rangeTourSpeed.addEventListener("input", (e) => {
      const mps = parseInt(e.target.value);
      const kmh = Math.round(mps * 3.6);
      labelTourSpeed.innerText = `${mps} m/s (~${kmh} km/h)`;
    });
  }

  // Redraw polyline dynamically when settings change
  selectPolyAltMode.addEventListener("change", updatePolylineFromSettings);
  selectPolyAltVal.addEventListener("change", updatePolylineFromSettings);

  // Toggle Chase Cam settings panel dynamically based on selectTourView value
  if (selectTourView && chaseCamSettings) {
    selectTourView.addEventListener("change", () => {
      if (selectTourView.value === "tp") {
        chaseCamSettings.style.display = "block";
      } else {
        chaseCamSettings.style.display = "none";
      }
    });
  }

  // Chase Cam sliders listeners
  if (rangeChaseDistance && labelChaseDistance) {
    rangeChaseDistance.addEventListener("input", (e) => {
      labelChaseDistance.innerText = `${e.target.value}m`;
    });
  }

  if (rangeChaseHeight && labelChaseHeight) {
    rangeChaseHeight.addEventListener("input", (e) => {
      labelChaseHeight.innerText = `${e.target.value}m`;
    });
  }

  if (rangeChaseHeading && labelChaseHeading) {
    rangeChaseHeading.addEventListener("input", (e) => {
      labelChaseHeading.innerText = `${e.target.value}°`;
    });
  }

  if (rangeChaseTilt && labelChaseTilt) {
    rangeChaseTilt.addEventListener("input", (e) => {
      labelChaseTilt.innerText = `${e.target.value}°`;
    });
  }
}

function flyTo(destKey) {
  if (!mapElement) return;

  // Stop any active animation
  mapElement.stopCameraAnimation();

  currentDestKey = destKey;
  isTransitioning = true;
  isOrbiting = false;

  // Update selection select box value
  if (selectDestination) {
    selectDestination.value = destKey;
  }

  // Update control buttons
  btnOrbit.disabled = true;
  btnOrbit.innerHTML = `<span style="display:inline-block; animation:spin 1s infinite linear; margin-right:4px;">⏳</span> Flying...`;
  btnStop.disabled = false;

  const dest = DESTINATIONS[destKey];
  
  // Fly to target
  mapElement.flyCameraTo({
    endCamera: {
      center: dest.center,
      tilt: dest.tilt,
      heading: dest.heading,
      range: dest.range
    },
    durationMillis: 6000 // 6 seconds duration for flight transition
  });
}

function handleAnimationEnd() {
  // If we just flew to a destination, automatically start orbiting around it!
  if (isTransitioning && !isOrbiting) {
    isTransitioning = false;
    startOrbit();
  }
}

function startOrbit() {
  if (!mapElement) return;

  // Stop any previous animation first
  mapElement.stopCameraAnimation();

  isOrbiting = true;
  isTransitioning = false;

  // Update control button states
  btnOrbit.disabled = true;
  btnOrbit.innerHTML = `<svg class="icon" viewBox="0 0 24 24" style="animation: spin 8s infinite linear;"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg> Orbiting...`;
  btnStop.disabled = false;

  const dest = DESTINATIONS[currentDestKey];
  
  // Orbit around the target
  mapElement.flyCameraAround({
    camera: {
      center: dest.center,
      tilt: dest.tilt,
      heading: dest.heading,
      range: dest.range
    },
    durationMillis: 45000, // 45 seconds for a complete rotation
    repeatCount: Infinity
  });
}

function stopAnimation() {
  if (!mapElement) return;

  mapElement.stopCameraAnimation();
  isOrbiting = false;
  isTransitioning = false;

  if (isTouring) {
    stopTour();
  }

  // Reset control button states
  btnOrbit.disabled = false;
  btnOrbit.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12C20,13.62 19.5,15.14 18.67,16.4L16.29,14.03C16.74,13.43 17,12.75 17,12A5,5 0 0,0 12,7C11.25,7 10.57,7.26 9.97,7.71L7.6,5.33C8.86,4.5 10.38,4 12,4M12,9A3,3 0 0,1 15,12C15,12.72 14.72,13.38 14.28,13.88L13.88,14.28C13.38,14.72 12.72,15 12,15A3,3 0 0,1 9,12C9,11.28 9.28,10.62 9.72,10.12L10.12,9.72C10.62,9.28 11.28,9 12,9M12,17A5,5 0 0,0 14.03,16.29L16.4,18.67C15.14,19.5 13.62,20 12,20A8,8 0 0,1 4,12C4,10.38 4.5,8.86 5.33,7.6L7.71,9.97C7.26,10.57 7,11.25 7,12A5,5 0 0,0 12,17Z"/></svg> Start Orbit`;
  btnStop.disabled = true;
}

// --- Route Planner Functionality ---

async function drawRoute() {
  const originVal = autocompleteState.origin.input.value.trim();
  const destVal = autocompleteState.destination.input.value.trim();

  if (!originVal || !destVal) {
    alert("Please enter both Origin and Destination addresses.");
    return;
  }

  // Check if we have a Place object from autocomplete selection, otherwise pass the string
  const origin = autocompleteState.origin.selectedPlace || originVal;
  const destination = autocompleteState.destination.selectedPlace || destVal;

  btnDrawRoute.disabled = true;
  btnDrawRoute.innerText = "Drawing...";

  try {
    const { Route } = await importLibrary("routes");

    const request = {
      origin,
      destination,
      travelMode: "DRIVING",
      computeAlternativeRoutes: false,
      fields: ["path", "legs"]
    };

    const response = await Route.computeRoutes(request);
    const routes = response?.routes;

    if (!routes || routes.length === 0) {
      throw new Error("No route found between those addresses.");
    }

    const route = routes[0];
    if (!route.path || route.path.length === 0) {
      throw new Error("Route contains no coordinate path.");
    }

    // Store the path coordinates globally to allow live settings changes
    lastRoutePath = route.path;
    lastTurnPoints = getRouteTurnPoints(route);
    precomputePathDistances(route.path);

    // Render polyline
    await renderPolyline(route.path, lastTurnPoints);

    // Enable Tour button
    if (btnTour) {
      btnTour.disabled = false;
    }
  } catch (err) {
    console.error("Error drawing route:", err);
    alert(`Could not draw route: ${err.message}`);
  } finally {
    btnDrawRoute.disabled = false;
    btnDrawRoute.innerText = "Draw Route";
  }
}

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

async function renderPolyline(pathLatLngs, turnLatLngs = []) {
  const { Polyline3DElement, Polygon3DElement, AltitudeMode } = await importLibrary("maps3d");

  // Remove existing polyline if present
  if (activePolyline) {
    activePolyline.remove();
    activePolyline = null;
  }
  clearTurnMarkers();

  const altMode = AltitudeMode[selectPolyAltMode.value] || AltitudeMode.CLAMP_TO_GROUND;
  const altitude = parseFloat(selectPolyAltVal.value) || 0;

  // Transform standard LatLng path to LatLngAltitude objects safely
  const path = pathLatLngs.map(latLng => {
    const coords = getCoordinate(latLng);
    return {
      lat: coords.lat,
      lng: coords.lng,
      altitude: altitude
    };
  });

  // Create 3D Polyline Element
  activePolyline = new Polyline3DElement({
    path: path,
    altitudeMode: altMode,
    strokeColor: ROUTE_STROKE_COLOR,
    strokeWidth: ROUTE_STROKE_WIDTH,
    extruded: false
  });

  // Append the polyline to the 3D Map element
  mapElement.appendChild(activePolyline);

  renderTurnMarkers(turnLatLngs, Polygon3DElement, altMode, altitude);

  // Zoom camera to fit route bounds
  fitCameraToPath(path);
  window.setTimeout(scheduleTurnMarkerRedraw, 4200);
}

function updatePolylineFromSettings() {
  if (lastRoutePath) {
    renderPolyline(lastRoutePath, lastTurnPoints);
  }
}

function clearTurnMarkers() {
  activeTurnMarkers.forEach((marker) => marker.remove());
  activeTurnMarkers = [];
}

async function scheduleTurnMarkerRedraw() {
  if (!lastTurnPoints.length || turnMarkerRedrawId !== null) {
    return;
  }

  turnMarkerRedrawId = requestAnimationFrame(async () => {
    turnMarkerRedrawId = null;
    const { Polygon3DElement, AltitudeMode } = await importLibrary("maps3d");
    const altMode = AltitudeMode[selectPolyAltMode.value] || AltitudeMode.CLAMP_TO_GROUND;
    const altitude = parseFloat(selectPolyAltVal.value) || 0;
    renderTurnMarkers(lastTurnPoints, Polygon3DElement, altMode, altitude);
  });
}

function renderTurnMarkers(turnLatLngs, Polygon3DElement, altMode, altitude) {
  clearTurnMarkers();

  const markerRadius = getTurnMarkerRadiusMeters();

  turnLatLngs.forEach((turnLatLng) => {
    const coords = getCoordinate(turnLatLng);
    const marker = new Polygon3DElement({
      path: createCircleCoordinates(coords, markerRadius, altitude),
      altitudeMode: altMode,
      fillColor: "#ffffff",
      strokeColor: ROUTE_STROKE_COLOR,
      strokeWidth: 2,
      extruded: false
    });

    activeTurnMarkers.push(marker);
    mapElement.appendChild(marker);
  });
}

function getTurnMarkerRadiusMeters() {
  return getMetersPerScreenPixel() * ROUTE_STROKE_WIDTH * TURN_MARKER_SCALE / 2;
}

function getMetersPerScreenPixel() {
  const viewportHeight = Math.max(container?.clientHeight || window.innerHeight || 1, 1);
  const range = Math.max(Number(mapElement?.range) || 1000, 1);
  const tilt = Math.max(Number(mapElement?.tilt) || 0, 0);
  const tiltScale = Math.max(Math.cos(tilt * Math.PI / 180), 0.35);
  const verticalFov = APPROX_MAP3D_VERTICAL_FOV_DEGREES * Math.PI / 180;
  return (2 * range * Math.tan(verticalFov / 2) * tiltScale) / viewportHeight;
}

function offsetCoordinate(center, bearingDegrees, distanceMeters, altitude) {
  const earthRadiusMeters = 6378137;
  const latRad = center.lat * Math.PI / 180;
  const lngRad = center.lng * Math.PI / 180;
  const bearing = bearingDegrees * Math.PI / 180;
  const angularDistance = distanceMeters / earthRadiusMeters;
  const pointLatRad = Math.asin(
    Math.sin(latRad) * Math.cos(angularDistance) +
    Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const pointLngRad = lngRad + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
    Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(pointLatRad)
  );

  return {
    lat: pointLatRad * 180 / Math.PI,
    lng: pointLngRad * 180 / Math.PI,
    altitude
  };
}

function createCircleCoordinates(center, radiusMeters, altitude, segments = 32) {
  const coordinates = [];

  for (let i = 0; i < segments; i++) {
    coordinates.push(offsetCoordinate(center, (360 * i) / segments, radiusMeters, altitude));
  }

  return coordinates;
}

function getRouteTurnPoints(route) {
  const stepTurnPoints = getStepTurnPoints(route);
  if (stepTurnPoints.length > 0) {
    return stepTurnPoints;
  }

  return getGeometryTurnPoints(route.path || []);
}

function getStepTurnPoints(route) {
  const points = [];
  const legs = Array.isArray(route?.legs) ? route.legs : [];

  legs.forEach((leg) => {
    const steps = Array.isArray(leg?.steps) ? leg.steps : [];
    steps.slice(1).forEach((step) => {
      const startLocation = step.startLocation || step.start_location || step.start;
      if (startLocation) {
        points.push(startLocation);
      } else if (Array.isArray(step.path) && step.path.length > 0) {
        points.push(step.path[0]);
      }
    });
  });

  return dedupeNearbyPoints(points, 6);
}

function getGeometryTurnPoints(path) {
  if (!Array.isArray(path) || path.length < 3) {
    return [];
  }

  const turns = [];
  const minSegmentMeters = 15;
  const minTurnDegrees = 35;

  for (let i = 1; i < path.length - 1; i++) {
    const prev = getCoordinate(path[i - 1]);
    const current = getCoordinate(path[i]);
    const next = getCoordinate(path[i + 1]);
    const incomingDistance = getHaversineDistance(prev.lat, prev.lng, current.lat, current.lng);
    const outgoingDistance = getHaversineDistance(current.lat, current.lng, next.lat, next.lng);

    if (incomingDistance < minSegmentMeters || outgoingDistance < minSegmentMeters) {
      continue;
    }

    const incomingHeading = getHeading(prev.lat, prev.lng, current.lat, current.lng);
    const outgoingHeading = getHeading(current.lat, current.lng, next.lat, next.lng);
    let turnAngle = Math.abs(outgoingHeading - incomingHeading);
    if (turnAngle > 180) turnAngle = 360 - turnAngle;

    if (turnAngle >= minTurnDegrees) {
      turns.push(path[i]);
    }
  }

  return dedupeNearbyPoints(turns, 12);
}

function dedupeNearbyPoints(points, thresholdMeters) {
  const unique = [];

  points.forEach((point) => {
    const coords = getCoordinate(point);
    const isDuplicate = unique.some((existingPoint) => {
      const existingCoords = getCoordinate(existingPoint);
      return getHaversineDistance(
        coords.lat,
        coords.lng,
        existingCoords.lat,
        existingCoords.lng
      ) < thresholdMeters;
    });

    if (!isDuplicate) {
      unique.push(point);
    }
  });

  return unique;
}

function getHaversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // distance in meters
}

function fitCameraToPath(path) {
  if (!mapElement || path.length === 0) return;

  // Stop any active camera movement first
  mapElement.stopCameraAnimation();
  isTransitioning = false;
  isOrbiting = false;

  // Reset orbit/stop button states to match stopped state
  btnOrbit.disabled = false;
  btnOrbit.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12C20,13.62 19.5,15.14 18.67,16.4L16.29,14.03C16.74,13.43 17,12.75 17,12A5,5 0 0,0 12,7C11.25,7 10.57,7.26 9.97,7.71L7.6,5.33C8.86,4.5 10.38,4 12,4M12,9A3,3 0 0,1 15,12C15,12.72 14.72,13.38 14.28,13.88L13.88,14.28C13.38,14.72 12.72,15 12,15A3,3 0 0,1 9,12C9,11.28 9.28,10.62 9.72,10.12L10.12,9.72C10.62,9.28 11.28,9 12,9M12,17A5,5 0 0,0 14.03,16.29L16.4,18.67C15.14,19.5 13.62,20 12,20A8,8 0 0,1 4,12C4,10.38 4.5,8.86 5.33,7.6L7.71,9.97C7.26,10.57 7,11.25 7,12A5,5 0 0,0 12,17Z"/></svg> Start Orbit`;
  btnStop.disabled = true;

  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  let sumLat = 0, sumLng = 0, sumAlt = 0;

  path.forEach(pt => {
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
    if (pt.lng < minLng) minLng = pt.lng;
    if (pt.lng > maxLng) maxLng = pt.lng;

    sumLat += pt.lat;
    sumLng += pt.lng;
    sumAlt += pt.altitude;
  });

  const centerLat = sumLat / path.length;
  const centerLng = sumLng / path.length;
  const centerAlt = sumAlt / path.length;

  // Calculate diagonal distance between corners
  const diagonalDistance = getHaversineDistance(minLat, minLng, maxLat, maxLng);

  // Set the camera range proportional to the route span (with 2.0 multiplier for padding to prevent bottom cutoff due to 45-degree tilt)
  const computedRange = Math.max(diagonalDistance * 2.0, 1000);

  // Compute overall heading of the route to align camera along the travel direction
  const startPt = path[0];
  const endPt = path[path.length - 1];
  const overallHeading = getHeading(startPt.lat, startPt.lng, endPt.lat, endPt.lng);

  mapElement.flyCameraTo({
    endCamera: {
      center: { lat: centerLat, lng: centerLng, altitude: centerAlt },
      range: computedRange,
      tilt: 45, // Angle view to show depth
      heading: overallHeading,
      altitudeMode: getCameraAltitudeMode()
    },
    durationMillis: 4000
  });
}

function clearRoute() {
  // Reset values
  autocompleteState.origin.input.value = "";
  autocompleteState.origin.selectedPlace = null;
  autocompleteState.destination.input.value = "";
  autocompleteState.destination.selectedPlace = null;
  lastRoutePath = null;
  lastTurnPoints = [];

  hideSuggestions("origin");
  hideSuggestions("destination");

  // Remove polyline
  if (activePolyline) {
    activePolyline.remove();
    activePolyline = null;
  }
  clearTurnMarkers();
  if (turnMarkerRedrawId !== null) {
    cancelAnimationFrame(turnMarkerRedrawId);
    turnMarkerRedrawId = null;
  }

  // Reset tour controls
  if (btnTour) {
    btnTour.disabled = true;
    btnTour.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path fill="currentColor" d="M19,12L15,8V11H5V13H15V16L19,12Z"/></svg> Route Tour`;
  }
  if (isTouring) {
    stopTour();
  }
}

// --- First-Person Route Tour Animation ---

function getHeading(lat1, lng1, lat2, lng2) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;

  const y = Math.sin(dLng) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);

  const brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360; // return bearing in 0-360 degrees
}

function interpolateHeading(current, target, lerpFactor) {
  let diff = target - current;
  while (diff < -180) diff += 360;
  while (diff > 180) diff -= 360;
  return (current + diff * lerpFactor + 360) % 360;
}

function getCameraAltitudeMode() {
  const routeAltMode = selectPolyAltMode ? selectPolyAltMode.value : "CLAMP_TO_GROUND";
  if (routeAltMode === "CLAMP_TO_GROUND") {
    return "RELATIVE_TO_GROUND";
  }
  return routeAltMode;
}

function getPositionAtDistance(progress) {
  let targetProgress = progress;
  if (targetProgress >= totalPathDistance) {
    targetProgress = totalPathDistance;
  }
  if (targetProgress < 0) {
    targetProgress = 0;
  }

  let idx = 0;
  while (idx < pathDistances.length - 2 && pathDistances[idx + 1] < targetProgress) {
    idx++;
  }

  const segmentDist = pathDistances[idx + 1] - pathDistances[idx];
  const distInSegment = targetProgress - pathDistances[idx];
  const frac = segmentDist > 0 ? distInSegment / segmentDist : 0;

  const p1 = getCoordinate(lastRoutePath[idx]);
  const p2 = getCoordinate(lastRoutePath[idx + 1] || lastRoutePath[idx]);

  return {
    lat: p1.lat + (p2.lat - p1.lat) * frac,
    lng: p1.lng + (p2.lng - p1.lng) * frac
  };
}

function precomputePathDistances(path) {
  pathDistances = [0];
  totalPathDistance = 0;
  for (let i = 1; i < path.length; i++) {
    const p1 = getCoordinate(path[i - 1]);
    const p2 = getCoordinate(path[i]);
    const dist = getHaversineDistance(p1.lat, p1.lng, p2.lat, p2.lng);
    totalPathDistance += dist;
    pathDistances.push(totalPathDistance);
  }
}

function startTour() {
  if (!mapElement || !lastRoutePath || lastRoutePath.length < 2) return;

  // Stop any active camera movement
  mapElement.stopCameraAnimation();
  isOrbiting = false;
  isTransitioning = false;

  isTouring = true;
  tourProgress = 0;
  currentTourHeading = null; // Reset tour heading smoothing on start
  smoothCameraCenter = null;
  smoothHeading = null;
  smoothTilt = null;
  smoothRange = null;
  lastFrameTime = null;

  // Toggle button states (disable tour button while aligning)
  btnOrbit.disabled = true;
  btnStop.disabled = false;
  
  if (btnTour) {
    btnTour.disabled = true;
    btnTour.innerHTML = `<span style="display:inline-block; animation:spin 2s infinite linear; margin-right:4px;">✈️</span> Aligning...`;
  }

  // Pre-calculate starting camera values
  const p1 = getCoordinate(lastRoutePath[0]);
  const p2 = getCoordinate(lastRoutePath[1]);
  const startHeading = getHeading(p1.lat, p1.lng, p2.lat, p2.lng);

  const altitude = parseFloat(selectPolyAltVal.value) || 0;
  const viewType = selectTourView ? selectTourView.value : "fp";
  const tourHeightOffset = rangeTourAltitude ? parseFloat(rangeTourAltitude.value) : 10;

  let targetCenter, targetTilt, targetRange, targetHeadingVal;
  targetHeadingVal = startHeading;

  if (viewType === "tp") {
    // Read Chase Cam specific settings
    const chaseDistance = rangeChaseDistance ? parseFloat(rangeChaseDistance.value) : 50;
    const chaseHeight = rangeChaseHeight ? parseFloat(rangeChaseHeight.value) : 15;
    const chaseHeadingOffset = rangeChaseHeading ? parseFloat(rangeChaseHeading.value) : 0;
    const chaseTilt = rangeChaseTilt ? parseFloat(rangeChaseTilt.value) : 65;

    targetCenter = { lat: p1.lat, lng: p1.lng, altitude: altitude + chaseHeight };
    targetTilt = chaseTilt;
    targetRange = chaseDistance;
    targetHeadingVal = (startHeading + chaseHeadingOffset + 360) % 360;
  } else {
    targetCenter = { lat: p1.lat, lng: p1.lng, altitude: altitude + tourHeightOffset };
    targetTilt = 80;
    targetRange = 0.1;
  }

  // 1. Fly camera smoothly to the starting point of the route
  mapElement.flyCameraTo({
    endCamera: {
      center: targetCenter,
      heading: targetHeadingVal,
      tilt: targetTilt,
      range: targetRange,
      altitudeMode: getCameraAltitudeMode()
    },
    durationMillis: 3000 // 3 seconds smooth alignment flight
  });

  // 2. Wait for alignment flight to finish before starting the frame tour loop
  const onAlignComplete = () => {
    if (isTouring) {
      if (btnTour) {
        btnTour.disabled = false;
        btnTour.innerHTML = `<span style="display:inline-block; animation:spin 2s infinite linear; margin-right:4px;">🚗</span> Touring...`;
      }
      currentTourHeading = targetHeadingVal;
      smoothCameraCenter = { lat: p1.lat, lng: p1.lng, altitude: targetCenter.altitude };
      smoothHeading = targetHeadingVal;
      smoothTilt = targetTilt;
      smoothRange = targetRange;
      tourAnimationId = requestAnimationFrame(animateTour);
    }
  };

  mapElement.addEventListener("gmp-animationend", onAlignComplete, { once: true });
}

function stopTour() {
  isTouring = false;
  if (tourAnimationId) {
    cancelAnimationFrame(tourAnimationId);
    tourAnimationId = null;
  }

  // Reset smooth camera states
  smoothCameraCenter = null;
  smoothHeading = null;
  smoothTilt = null;
  smoothRange = null;
  currentTourHeading = null;
  lastFrameTime = null;

  // Halt camera flight if alignment is still running
  if (mapElement) {
    mapElement.stopCameraAnimation();
  }

  if (btnTour) {
    btnTour.disabled = false;
    btnTour.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path fill="currentColor" d="M19,12L15,8V11H5V13H15V16L19,12Z"/></svg> Route Tour`;
  }

  // Restore button states
  btnOrbit.disabled = false;
  btnStop.disabled = true;
}

function animateTour(timestamp) {
  if (!isTouring || !lastRoutePath || lastRoutePath.length < 2 || pathDistances.length < 2) {
    stopTour();
    return;
  }

  // Calculate delta time in seconds to make camera movement frame-rate independent
  if (!timestamp) timestamp = performance.now();
  if (lastFrameTime === null) {
    lastFrameTime = timestamp;
    tourAnimationId = requestAnimationFrame(animateTour);
    return;
  }

  const dt = Math.min((timestamp - lastFrameTime) / 1000, 0.1); // Clamp to 100ms max to prevent jumps
  lastFrameTime = timestamp;

  // Read tour speed dynamically from the slider in meters per second (default 20 m/s)
  const speedMPS = rangeTourSpeed ? parseFloat(rangeTourSpeed.value) : 20.0;

  tourProgress += speedMPS * dt;

  // Clamp route to the end when tour ends
  let reachedEnd = false;
  if (tourProgress >= totalPathDistance) {
    tourProgress = totalPathDistance;
    reachedEnd = true;
  }

  // Get current position at progress
  const currentPos = getPositionAtDistance(tourProgress);
  const lat = currentPos.lat;
  const lng = currentPos.lng;

  // Look-ahead distance: default 25 meters, scales up with speed for smooth leading curves
  const lookAheadDistance = Math.max(speedMPS * dt * 25, 25);
  
  // Calculate target heading directly towards the look-ahead point, or maintain final segment heading near the end
  let targetHeading;
  if (tourProgress + lookAheadDistance < totalPathDistance) {
    const aheadPos = getPositionAtDistance(tourProgress + lookAheadDistance);
    targetHeading = getHeading(lat, lng, aheadPos.lat, aheadPos.lng);
  } else {
    // Near the end: use the last segment's heading direction to prevent rotation anomalies
    const pEnd = getCoordinate(lastRoutePath[lastRoutePath.length - 1]);
    const pPenultimate = getCoordinate(lastRoutePath[lastRoutePath.length - 2]);
    targetHeading = getHeading(pPenultimate.lat, pPenultimate.lng, pEnd.lat, pEnd.lng);
  }

  // Read routing altitude setting
  const altitude = parseFloat(selectPolyAltVal.value) || 0;

  // Read view type (First-Person vs Chase Cam)
  const viewType = selectTourView ? selectTourView.value : "fp";

  // Read tour camera height offset dynamically from slider (default 10m now)
  const tourHeightOffset = rangeTourAltitude ? parseFloat(rangeTourAltitude.value) : 10;
  const cameraAltMode = getCameraAltitudeMode();
  let targetAltitude = altitude + tourHeightOffset;
  let targetTilt = 80;
  let targetRange = 0.1;
  let finalTargetHeading = targetHeading;

  if (viewType === "tp") {
    // Read Chase Cam specific settings
    const chaseDistance = rangeChaseDistance ? parseFloat(rangeChaseDistance.value) : 50;
    const chaseHeight = rangeChaseHeight ? parseFloat(rangeChaseHeight.value) : 15;
    const chaseHeadingOffset = rangeChaseHeading ? parseFloat(rangeChaseHeading.value) : 0;
    const chaseTilt = rangeChaseTilt ? parseFloat(rangeChaseTilt.value) : 65;

    targetAltitude = altitude + chaseHeight;
    targetTilt = chaseTilt;
    targetRange = chaseDistance;
    finalTargetHeading = (targetHeading + chaseHeadingOffset + 360) % 360;
  }

  // Read camera suspension/gimbal smoothing factor from slider (default 90%, yielding k = 0.1)
  const suspensionVal = rangeCameraSuspension ? parseFloat(rangeCameraSuspension.value) : 90;
  
  // Base smoothing factor k for translation (position)
  const k = Math.max(1.0 - (suspensionVal / 100), 0.02);
  
  // Read turn smoothness slider (default 97%, yielding kHeading = 0.03)
  const turnSmoothnessVal = rangeTurnSmoothness ? parseFloat(rangeTurnSmoothness.value) : 97;
  // Map turn smoothness percentage (0 to 99) to yaw interpolation coefficient kHeading (1.0 to 0.01)
  const kHeading = Math.max(1.0 - (turnSmoothnessVal / 100), 0.01);

  // We damp altitude turning even further to avoid any vertical bumps/dips
  // Roads have very gradual slopes, but DTM data can have high-frequency noise.
  // Using a very small coefficient for altitude creates a vertical glide-cam effect.
  const kAltitude = k * 0.15;

  if (smoothCameraCenter === null) {
    smoothCameraCenter = { lat, lng, altitude: targetAltitude };
    smoothHeading = finalTargetHeading;
    smoothTilt = targetTilt;
    smoothRange = targetRange;
  } else {
    smoothCameraCenter.lat += (lat - smoothCameraCenter.lat) * k;
    smoothCameraCenter.lng += (lng - smoothCameraCenter.lng) * k;
    smoothCameraCenter.altitude += (targetAltitude - smoothCameraCenter.altitude) * kAltitude;
    smoothHeading = interpolateHeading(smoothHeading, finalTargetHeading, kHeading);
    smoothTilt += (targetTilt - smoothTilt) * k;
    smoothRange += (targetRange - smoothRange) * k;
  }

  mapElement.flyCameraTo({
    endCamera: {
      center: smoothCameraCenter,
      heading: smoothHeading,
      tilt: smoothTilt,
      range: smoothRange,
      altitudeMode: cameraAltMode
    },
    durationMillis: 0
  });

  // If we reached the end of the tour, check if camera has converged close enough to the destination
  if (reachedEnd) {
    const horizontalDist = getHaversineDistance(smoothCameraCenter.lat, smoothCameraCenter.lng, lat, lng);
    const altDiff = Math.abs(smoothCameraCenter.altitude - targetAltitude);
    let headingDiff = Math.abs(smoothHeading - finalTargetHeading);
    if (headingDiff > 180) headingDiff = 360 - headingDiff;

    // Once we are within a tiny threshold, stop the tour at the destination
    if (horizontalDist < 0.1 && altDiff < 0.1 && headingDiff < 0.5) {
      // Force exact target values to eliminate any residual offset
      smoothCameraCenter.lat = lat;
      smoothCameraCenter.lng = lng;
      smoothCameraCenter.altitude = targetAltitude;
      smoothHeading = finalTargetHeading;
      
      mapElement.flyCameraTo({
        endCamera: {
          center: smoothCameraCenter,
          heading: smoothHeading,
          tilt: smoothTilt,
          range: smoothRange,
          altitudeMode: cameraAltMode
        },
        durationMillis: 0
      });

      stopTour();
      return;
    }
  }

  tourAnimationId = requestAnimationFrame(animateTour);
}

// Run initializer
init();
