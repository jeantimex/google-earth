function createAutocompleteState() {
  return {
    sessionToken: null,
    suggestionsByLabel: new Map(),
    requestId: 0,
    debounceId: null,
    selectedPlace: null,
    popup: null,
    input: null,
    activeIndex: -1,
  };
}

export function createRouteControls({
  getMapsLibraries,
  onRoutesComputed,
  onClear,
  onToggleAnimation,
  onStopAnimation,
}) {
  const routeParams = {
    origin: "",
    destination: "",
    showRoutes: async () => {
      await computeAndEmitRoutes("DRIVING");
    },
    showTransits: async () => {
      await computeAndEmitRoutes("TRANSIT");
    },
    clear: () => {
      clearRouteInputs();
      onClear?.();
    },
    startPauseRoutesAnimation: () => {
      onToggleAnimation?.();
    },
    stopRoutesAnimation: () => {
      onStopAnimation?.();
    },
  };

  async function computeAndEmitRoutes(travelMode) {
    try {
      const { Route } = await getMapsLibraries();
      const origin = getRouteEndpoint("origin");
      const destination = getRouteEndpoint("destination");

      if (!origin || !destination) {
        console.warn("Both Origin and Destination are required.");
        return;
      }

      const request = {
        origin,
        destination,
        travelMode,
        computeAlternativeRoutes: true,
        ...(travelMode === "TRANSIT"
          ? {
              departureTime: new Date(Date.now() + 30 * 60 * 1000),
              transitPreference: {
                allowedTransitModes: [
                  "BUS",
                  "SUBWAY",
                  "TRAIN",
                  "LIGHT_RAIL",
                  "RAIL",
                ],
                routingPreference: "FEWER_TRANSFERS",
              },
            }
          : {}),
        fields:
          travelMode === "TRANSIT"
            ? ["path", "legs", "travelAdvisory", "localizedValues"]
            : ["path", "legs", "distanceMeters", "durationMillis"],
      };

      if (travelMode === "TRANSIT") {
        console.log("Transit route request", request);
      }

      const response = await Route.computeRoutes(request);

      console.log(`Route.computeRoutes response [${travelMode}]`, response);
      await onRoutesComputed?.(response);
    } catch (error) {
      console.error(`Failed to compute ${travelMode.toLowerCase()} routes.`, error);
    }
  }

  const routeAutocompleteState = {
    origin: createAutocompleteState(),
    destination: createAutocompleteState(),
  };
  const fields = ["origin", "destination"];

  window.addEventListener("resize", updateAutocompletePopupPositions, false);
  window.addEventListener("scroll", updateAutocompletePopupPositions, true);
  document.addEventListener("pointerdown", closeAllAutocompletePopups);

  function setup(folder) {
    const originController = folder.add(routeParams, "origin").name("Origin");
    const destinationController = folder
      .add(routeParams, "destination")
      .name("Destination");

    bindAutocompleteController(originController, "origin");
    bindAutocompleteController(destinationController, "destination");

    folder.add(routeParams, "showRoutes").name("Show Routes");
    folder.add(routeParams, "showTransits").name("Show Transits");
    folder.add(routeParams, "clear").name("Clear");
    folder
      .add(routeParams, "startPauseRoutesAnimation")
      .name("Start/Pause");
    folder.add(routeParams, "stopRoutesAnimation").name("Stop");
  }

  function preload() {
    return getMapsLibraries();
  }

  function bindAutocompleteController(controller, field) {
    const input = controller.domElement.querySelector("input");
    if (!input) {
      return;
    }

    const state = routeAutocompleteState[field];
    const popup = document.createElement("div");
    popup.className = "route-autocomplete-popup";
    popup.style.display = "none";
    document.body.appendChild(popup);

    state.popup = popup;
    state.input = input;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");

    input.addEventListener("focus", () => {
      beginAutocompleteSession(field);

      if (state.suggestionsByLabel.size > 0) {
        renderAutocompleteSuggestions(field);
      }
    });

    input.addEventListener("input", () => {
      const query = routeParams[field].trim();

      state.selectedPlace = null;
      syncSelectedPlace(field);

      if (state.debounceId) {
        window.clearTimeout(state.debounceId);
      }

      if (query.length < 2) {
        clearAutocompleteSuggestions(field);
        return;
      }

      state.debounceId = window.setTimeout(() => {
        fetchAutocompleteSuggestions(field, query);
      }, 250);
    });

    input.addEventListener("change", () => {
      const selectedPlace = state.suggestionsByLabel.get(routeParams[field]);
      if (selectedPlace) {
        selectAutocompleteSuggestion(field, routeParams[field]);
      }
      syncSelectedPlace(field);
    });

    input.addEventListener("keydown", (event) => {
      const labels = [...state.suggestionsByLabel.keys()];
      if (labels.length === 0) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.activeIndex = (state.activeIndex + 1) % labels.length;
        renderAutocompleteSuggestions(field);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        state.activeIndex =
          (state.activeIndex - 1 + labels.length) % labels.length;
        renderAutocompleteSuggestions(field);
        return;
      }

      if (event.key === "Enter" && state.activeIndex >= 0) {
        event.preventDefault();
        selectAutocompleteSuggestion(field, labels[state.activeIndex]);
        return;
      }

      if (event.key === "Escape") {
        hideAutocompletePopup(field);
      }
    });

    input.addEventListener("blur", () => {
      window.setTimeout(() => {
        hideAutocompletePopup(field);
      }, 150);
    });
  }

  function beginAutocompleteSession(field) {
    const state = routeAutocompleteState[field];
    if (state.sessionToken) {
      return;
    }

    getMapsLibraries()
      .then(({ AutocompleteSessionToken }) => {
        state.sessionToken = new AutocompleteSessionToken();
      })
      .catch((error) => {
        console.error("Failed to start autocomplete session.", error);
      });
  }

  function endAutocompleteSession(field) {
    routeAutocompleteState[field].sessionToken = null;
  }

  function clearAutocompleteSuggestions(field) {
    const state = routeAutocompleteState[field];
    state.suggestionsByLabel.clear();
    state.activeIndex = -1;
    hideAutocompletePopup(field);
    renderAutocompleteSuggestions(field);
  }

  async function fetchAutocompleteSuggestions(field, query) {
    const state = routeAutocompleteState[field];
    const requestId = ++state.requestId;

    try {
      const { AutocompleteSuggestion, AutocompleteSessionToken } =
        await getMapsLibraries();

      if (!state.sessionToken) {
        state.sessionToken = new AutocompleteSessionToken();
      }

      const { suggestions } =
        await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: query,
          sessionToken: state.sessionToken,
        });

      if (requestId !== state.requestId) {
        return;
      }

      clearAutocompleteSuggestions(field);

      suggestions
        .filter((suggestion) => suggestion.placePrediction)
        .slice(0, 5)
        .forEach((suggestion) => {
          const label = suggestion.placePrediction.text.text;
          state.suggestionsByLabel.set(label, suggestion.placePrediction.toPlace());
        });

      state.activeIndex = state.suggestionsByLabel.size > 0 ? 0 : -1;
      renderAutocompleteSuggestions(field);
    } catch (error) {
      console.error(`Failed to fetch ${field} suggestions.`, error);
    }
  }

  function syncSelectedPlace(field) {
    const state = routeAutocompleteState[field];
    const selectedPlace = state.suggestionsByLabel.get(routeParams[field]);
    if (selectedPlace) {
      state.selectedPlace = selectedPlace;
    }
  }

  function getRouteEndpoint(field) {
    const selectedPlace = routeAutocompleteState[field].selectedPlace;
    if (selectedPlace) {
      return selectedPlace;
    }

    const value = routeParams[field].trim();
    return value || null;
  }

  function renderAutocompleteSuggestions(field) {
    const state = routeAutocompleteState[field];
    const { popup, input } = state;
    if (!popup || !input) {
      return;
    }

    popup.replaceChildren();

    if (!document.activeElement || document.activeElement !== input) {
      popup.style.display = "none";
      return;
    }

    const labels = [...state.suggestionsByLabel.keys()];
    if (labels.length === 0) {
      popup.style.display = "none";
      return;
    }

    labels.forEach((label) => {
      const index = popup.childElementCount;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "route-autocomplete-option";
      button.textContent = label;

      if (index === state.activeIndex) {
        button.classList.add("active");
      }

      button.addEventListener("mouseenter", () => {
        state.activeIndex = index;
        updateAutocompleteOptionHighlight(field);
      });

      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        selectAutocompleteSuggestion(field, label);
      });

      popup.appendChild(button);
    });

    positionAutocompletePopup(field);
    popup.style.display = "flex";
  }

  function positionAutocompletePopup(field) {
    const state = routeAutocompleteState[field];
    const { popup, input } = state;
    if (!popup || !input) {
      return;
    }

    const rect = input.getBoundingClientRect();
    const popupWidth = Math.max(rect.width + 180, 320);
    const gui = input.closest(".lil-gui");
    const guiRect = gui?.getBoundingClientRect();
    const left = guiRect
      ? Math.max(guiRect.right - popupWidth, 0)
      : rect.left;

    popup.style.left = `${left}px`;
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.width = `${popupWidth}px`;
  }

  function hideAutocompletePopup(field) {
    const state = routeAutocompleteState[field];
    const popup = state.popup;
    if (popup) {
      popup.style.display = "none";
    }
    state.activeIndex = -1;
  }

  function controllerUpdateDisplay(field) {
    const state = routeAutocompleteState[field];
    if (state.input) {
      state.input.value = routeParams[field];
    }
  }

  function updateAutocompleteOptionHighlight(field) {
    const popup = routeAutocompleteState[field].popup;
    const activeIndex = routeAutocompleteState[field].activeIndex;
    if (!popup) {
      return;
    }

    [...popup.children].forEach((child, index) => {
      child.classList.toggle("active", index === activeIndex);
    });
  }

  function selectAutocompleteSuggestion(field, label) {
    const state = routeAutocompleteState[field];
    routeParams[field] = label;
    state.selectedPlace = state.suggestionsByLabel.get(label) || null;
    state.activeIndex = [...state.suggestionsByLabel.keys()].indexOf(label);
    controllerUpdateDisplay(field);
    endAutocompleteSession(field);
    clearAutocompleteSuggestions(field);
    hideAutocompletePopup(field);
    state.input?.blur();
  }

  function clearRouteInputs() {
    fields.forEach((field) => {
      const state = routeAutocompleteState[field];
      routeParams[field] = "";
      state.selectedPlace = null;
      state.suggestionsByLabel.clear();
      state.requestId += 1;

      if (state.debounceId) {
        window.clearTimeout(state.debounceId);
        state.debounceId = null;
      }

      endAutocompleteSession(field);
      hideAutocompletePopup(field);
      controllerUpdateDisplay(field);
      state.input?.blur();
    });
  }

  function closeAllAutocompletePopups(event) {
    fields.forEach((field) => {
      const state = routeAutocompleteState[field];
      const clickedInsideInput = state.input?.contains(event.target);
      const clickedInsidePopup = state.popup?.contains(event.target);

      if (!clickedInsideInput && !clickedInsidePopup) {
        hideAutocompletePopup(field);
      }
    });
  }

  function updateAutocompletePopupPositions() {
    fields.forEach((field) => {
      const popup = routeAutocompleteState[field].popup;
      if (popup && popup.style.display !== "none") {
        positionAutocompletePopup(field);
      }
    });
  }

  return {
    setup,
    preload,
  };
}
