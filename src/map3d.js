import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

// Coordinate definitions for destinations
const DESTINATIONS = {
  sf: {
    center: { lat: 37.7749, lng: -122.4194, altitude: 100 },
    tilt: 60,
    heading: 0,
    range: 1500
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

let mapElement = null;
let currentDestKey = "sf";
let isOrbiting = false;
let isTransitioning = false;
let activePolyline = null;
let lastRoutePath = null; // Stored path coordinate lat/lng points to support dynamic redraws

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

  // Map Mode selection
  selectMode.addEventListener("change", (e) => {
    if (mapElement) {
      mapElement.mode = e.target.value;
    }
  });

  // User click on map should stop animation
  mapElement.addEventListener("gmp-click", () => {
    if (isOrbiting || isTransitioning) {
      stopAnimation();
    }
  });

  // Route Planning Event Listeners
  btnDrawRoute.addEventListener("click", drawRoute);
  btnClearRoute.addEventListener("click", clearRoute);

  // Redraw polyline dynamically when settings change
  selectPolyAltMode.addEventListener("change", updatePolylineFromSettings);
  selectPolyAltVal.addEventListener("change", updatePolylineFromSettings);
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

    // Render polyline
    await renderPolyline(route.path);
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

async function renderPolyline(pathLatLngs) {
  const { Polyline3DElement, AltitudeMode } = await importLibrary("maps3d");

  // Remove existing polyline if present
  if (activePolyline) {
    activePolyline.remove();
    activePolyline = null;
  }

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
    strokeColor: "#64ffda", // Neon cyan
    strokeWidth: 8,
    extruded: false
  });

  // Append the polyline to the 3D Map element
  mapElement.appendChild(activePolyline);

  // Zoom camera to fit route bounds
  fitCameraToPath(path);
}

function updatePolylineFromSettings() {
  if (lastRoutePath) {
    renderPolyline(lastRoutePath);
  }
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

  path.forEach(pt => {
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
    if (pt.lng < minLng) minLng = pt.lng;
    if (pt.lng > maxLng) maxLng = pt.lng;
  });

  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;

  // Calculate diagonal distance between corners
  const diagonalDistance = getHaversineDistance(minLat, minLng, maxLat, maxLng);

  // Set the camera range proportional to the route span (with 1.4 multiplier for padding)
  const computedRange = Math.max(diagonalDistance * 1.4, 600);

  mapElement.flyCameraTo({
    endCamera: {
      center: { lat: centerLat, lng: centerLng, altitude: 0 },
      range: computedRange,
      tilt: 45, // Angle view to show depth
      heading: 0
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

  hideSuggestions("origin");
  hideSuggestions("destination");

  // Remove polyline
  if (activePolyline) {
    activePolyline.remove();
    activePolyline = null;
  }
}

// Run initializer
init();
