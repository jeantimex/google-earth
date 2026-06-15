import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import {
  DEFAULT_TOUR_CAMERA_ALTITUDE_MODE,
  RouteTourAnimation,
  getCoordinate,
  getHaversineDistance,
  getHeading
} from "./route-animation.js";

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
const ELEVATION_REQUEST_CHUNK_SIZE = 512;

let mapElement = null;
let currentDestKey = "sf";
let isOrbiting = false;
let isTransitioning = false;
let activePolyline = null;
let routeAnimator = null;
let lastRoutePath = null; // Stored path coordinate lat/lng points to support dynamic redraws
let lastRouteElevations = []; // Ground elevation per route path point, meters above sea level

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
const rangePolyAltVal = document.getElementById("range-poly-alt-val");
const labelPolyAltVal = document.getElementById("label-poly-alt-val");
const btnTour = document.getElementById("btn-tour");
const rangeTourSpeed = document.getElementById("range-tour-speed");
const labelTourSpeed = document.getElementById("label-tour-speed");
const selectTourView = document.getElementById("select-tour-view");
const selectTourAltMode = document.getElementById("select-tour-alt-mode");
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
  libraries: ["maps3d", "places", "routes", "elevation"]
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
    routeAnimator = createRouteAnimator();

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

function createRouteAnimator() {
  return new RouteTourAnimation({
    mapElement,
    options: {
      getSpeedMPS: () => rangeTourSpeed ? parseFloat(rangeTourSpeed.value) : 20.0,
      getViewType: () => selectTourView ? selectTourView.value : "fp",
      getCameraAltitudeMode: getTourCameraAltitudeMode,
      getTourHeightOffset,
      getSuspension: () => rangeCameraSuspension ? parseFloat(rangeCameraSuspension.value) : 90,
      getTurnSmoothness: () => rangeTurnSmoothness ? parseFloat(rangeTurnSmoothness.value) : 97,
      getChaseDistance: () => rangeChaseDistance ? parseFloat(rangeChaseDistance.value) : 50,
      getChaseHeadingOffset: () => rangeChaseHeading ? parseFloat(rangeChaseHeading.value) : 0,
      getChaseTilt: () => rangeChaseTilt ? parseFloat(rangeChaseTilt.value) : 65
    },
    onStateChange: updateRouteTourControls
  });
}

function getCurrentRouteBaseAltitude() {
  return parseFloat(rangePolyAltVal?.value) || 0;
}

function updateRouteAnimatorRoute() {
  if (!routeAnimator || !lastRoutePath) return;

  routeAnimator.setRoute({
    path: lastRoutePath,
    elevations: lastRouteElevations,
    baseAltitude: getCurrentRouteBaseAltitude()
  });
}

function updateRouteTourControls(state) {
  if (state === "aligning") {
    btnOrbit.disabled = true;
    btnStop.disabled = false;
    if (btnTour) {
      btnTour.disabled = true;
      btnTour.innerHTML = `<span style="display:inline-block; animation:spin 2s infinite linear; margin-right:4px;">✈️</span> Aligning...`;
    }
    return;
  }

  if (state === "touring") {
    if (btnTour) {
      btnTour.disabled = false;
      btnTour.innerHTML = `<span style="display:inline-block; animation:spin 2s infinite linear; margin-right:4px;">🚗</span> Touring...`;
    }
    return;
  }

  if (btnTour) {
    btnTour.disabled = !lastRoutePath;
    btnTour.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path fill="currentColor" d="M19,12L15,8V11H5V13H15V16L19,12Z"/></svg> Route Tour`;
  }

  btnOrbit.disabled = false;
  btnStop.disabled = true;
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
      if (routeAnimator?.isTouring) {
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
    if (isOrbiting || isTransitioning || routeAnimator?.isTouring) {
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
  if (rangePolyAltVal && labelPolyAltVal) {
    rangePolyAltVal.addEventListener("input", (e) => {
      labelPolyAltVal.innerText = `${e.target.value}m`;
      updatePolylineFromSettings();
    });
  }

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

  if (routeAnimator?.isTouring) {
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
    lastRouteElevations = await fetchRouteElevations(route.path);
    updateRouteAnimatorRoute();

    // Render polyline
    await renderPolyline(route.path, { fitCamera: true });

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

async function renderPolyline(pathLatLngs, { fitCamera = false } = {}) {
  const { Polyline3DElement, AltitudeMode } = await importLibrary("maps3d");

  // Remove existing polyline if present
  if (activePolyline) {
    activePolyline.remove();
    activePolyline = null;
  }

  const altMode = AltitudeMode[selectPolyAltMode.value] || AltitudeMode.CLAMP_TO_GROUND;
  const altitude = getCurrentRouteBaseAltitude();

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

  if (fitCamera) {
    fitCameraToPath(path);
  }
}

function updatePolylineFromSettings() {
  if (lastRoutePath) {
    renderPolyline(lastRoutePath);
  }
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
  lastRouteElevations = [];
  routeAnimator?.clearRoute();

  hideSuggestions("origin");
  hideSuggestions("destination");

  // Remove polyline
  if (activePolyline) {
    activePolyline.remove();
    activePolyline = null;
  }

  // Reset tour controls
  if (btnTour) {
    btnTour.disabled = true;
    btnTour.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path fill="currentColor" d="M19,12L15,8V11H5V13H15V16L19,12Z"/></svg> Route Tour`;
  }
  if (routeAnimator?.isTouring) {
    stopTour();
  }
}

// --- Route Tour Animation Wiring ---

function getCameraAltitudeMode() {
  const routeAltMode = selectPolyAltMode ? selectPolyAltMode.value : "CLAMP_TO_GROUND";
  if (routeAltMode === "CLAMP_TO_GROUND") {
    return "RELATIVE_TO_GROUND";
  }
  return routeAltMode;
}

function getTourCameraAltitudeMode() {
  return selectTourAltMode?.value || DEFAULT_TOUR_CAMERA_ALTITUDE_MODE;
}

async function fetchRouteElevations(path) {
  const fallback = new Array(path.length).fill(0);

  try {
    const { ElevationService } = await importLibrary("elevation");
    const elevationService = new ElevationService();
    const elevations = [];

    for (let i = 0; i < path.length; i += ELEVATION_REQUEST_CHUNK_SIZE) {
      const pathChunk = path.slice(i, i + ELEVATION_REQUEST_CHUNK_SIZE);
      const locations = pathChunk.map((point) => {
        const coords = getCoordinate(point);
        return { lat: coords.lat, lng: coords.lng };
      });
      const response = await elevationService.getElevationForLocations({ locations });
      elevations.push(...locations.map((_, index) => response.results?.[index]?.elevation ?? 0));
    }

    return elevations.length === path.length ? elevations : fallback;
  } catch (error) {
    console.warn("Failed to fetch route elevations. Absolute tour altitude will use 0m base.", error);
    return fallback;
  }
}

function getTourHeightOffset(viewType) {
  if (viewType === "tp") {
    return rangeChaseHeight ? parseFloat(rangeChaseHeight.value) : 15;
  }

  return rangeTourAltitude ? parseFloat(rangeTourAltitude.value) : 10;
}

function startTour() {
  if (!routeAnimator?.canStart()) return;

  isOrbiting = false;
  isTransitioning = false;
  updateRouteAnimatorRoute();
  routeAnimator.start({ baseAltitude: getCurrentRouteBaseAltitude() });
}

function stopTour() {
  routeAnimator?.stop();
}

// Run initializer
init();
