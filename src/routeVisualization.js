import { WGS84_ELLIPSOID } from "3d-tiles-renderer";
import {
  Box3,
  BoxGeometry,
  CircleGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Sphere,
  Vector3,
} from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

const MARKER_SEGMENTS = 24;

export function createRouteVisualization() {
  const routeGroup = new Group();
  routeGroup.name = "route-visualization";

  let activeTilesGroup = null;
  let lastResponse = null;
  let altitudeOffset = 0;
  let markerAltitudeOffset = 0;
  let markerRadius = 14;
  let primaryRouteMarkerPoints = [];
  let carMesh = null;
  let animationState = null;
  let firstPersonPose = null;
  const zAxis = new Vector3(0, 0, 1);
  const routeTangent = new Vector3();
  const routeNormal = new Vector3();
  const routeBinormal = new Vector3();
  const routeMatrix = new Matrix4();
  const routeColors = [
    new Color(0x1d4ed8),
    new Color(0x60a5fa),
    new Color(0x14b8a6),
    new Color(0xf97316),
    new Color(0xa855f7),
    new Color(0xef4444),
  ];

  function attachToTilesGroup(tilesGroup) {
    if (activeTilesGroup === tilesGroup) {
      return;
    }

    routeGroup.removeFromParent();
    activeTilesGroup = tilesGroup;
    primaryRouteMarkerPoints = [];
    animationState = null;
    carMesh = null;
    firstPersonPose = null;

    if (activeTilesGroup?.parent) {
      activeTilesGroup.parent.add(routeGroup);
    }

    if (lastResponse) {
      render(lastResponse);
    }
  }

  function render(response) {
    lastResponse = response;
    clear();

    if (!activeTilesGroup) {
      return;
    }

    const routes = response?.routes?.filter(
      (route) => Array.isArray(route.path) && route.path.length > 0
    );
    if (!routes?.length) {
      return null;
    }

    const allPoints = [];
    primaryRouteMarkerPoints = [];

    routes.forEach((route, routeIndex) => {
      const routeColor = routeColors[routeIndex % routeColors.length];
      const stepSegments = getRouteSegments(route);

      stepSegments.forEach((segment) => {
        const points = segment.path.map((point) =>
          routePointToVector3(point).applyMatrix4(activeTilesGroup.matrixWorld)
        );
        if (points.length < 2) {
          return;
        }

        allPoints.push(...points);

        const lineGeometry = new LineGeometry();
        lineGeometry.setPositions(
          points.flatMap((point) => [point.x, point.y, point.z])
        );
        const lineMaterial = new LineMaterial({
          color: routeColor,
          linewidth: routeIndex === 0 ? 6 : 4,
          worldUnits: true,
          dashed: segment.travelMode === "WALKING",
          dashSize: 12,
          gapSize: 8,
        });
        lineMaterial.resolution.set(window.innerWidth, window.innerHeight);

        const line = new Line2(lineGeometry, lineMaterial);
        line.computeLineDistances();
        routeGroup.add(line);
      });

      const markerPoints = route.path.map((point) =>
        routePointToVector3(point, markerAltitudeOffset).applyMatrix4(
          activeTilesGroup.matrixWorld
        )
      );

      if (routeIndex === 0) {
        primaryRouteMarkerPoints = markerPoints.map((point) => point.clone());
      }

      const markerMaterial = new MeshBasicMaterial({
        color: routeColor,
        transparent: true,
        opacity: routeIndex === 0 ? 0.95 : 0.8,
      });

      markerPoints.forEach((point) => {
        const marker = new Mesh(
          new CircleGeometry(markerRadius, MARKER_SEGMENTS),
          markerMaterial.clone()
        );
        const normal = point.clone().normalize();
        marker.position.copy(point);
        marker.quaternion.copy(
          new Quaternion().setFromUnitVectors(zAxis, normal)
        );
        routeGroup.add(marker);
      });
    });

    const bounds = new Sphere();
    new Box3().setFromPoints(allPoints).getBoundingSphere(bounds);
    return { points: allPoints, bounds };
  }

  function clear() {
    lastResponse = null;
    animationState = null;
    primaryRouteMarkerPoints = [];
    carMesh = null;
    firstPersonPose = null;
    routeGroup.children.forEach((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material.dispose?.());
      } else {
        child.material?.dispose?.();
      }
    });
    routeGroup.clear();
  }

  function startAnimation() {
    if (primaryRouteMarkerPoints.length < 2) {
      console.warn("No primary route available to animate.");
      return;
    }

    const segmentLengths = [];
    let totalDistance = 0;

    for (let i = 0; i < primaryRouteMarkerPoints.length - 1; i += 1) {
      const length = primaryRouteMarkerPoints[i].distanceTo(
        primaryRouteMarkerPoints[i + 1]
      );
      segmentLengths.push(length);
      totalDistance += length;
    }

    animationState = {
      distance: 0,
      speed: 30,
      segmentLengths,
      totalDistance,
      paused: false,
    };

    if (!carMesh) {
      carMesh = new Mesh(
        new BoxGeometry(22, 12, 8),
        new MeshBasicMaterial({ color: 0xffffff })
      );
      routeGroup.add(carMesh);
    }

    updateCarTransform();
  }

  function update(deltaSeconds) {
    if (!animationState || !carMesh || animationState.paused) {
      return;
    }

    animationState.distance = Math.min(
      animationState.distance + animationState.speed * deltaSeconds,
      animationState.totalDistance
    );

    updateCarTransform();

    if (animationState.distance >= animationState.totalDistance) {
      animationState.paused = true;
    }
  }

  function setResolution(width, height) {
    routeGroup.children.forEach((child) => {
      if (child.material?.isLineMaterial) {
        child.material.resolution.set(width, height);
      }
    });
  }

  function routePointToVector3(point, additionalOffset = 0) {
    const lat = getPointValue(point, "lat");
    const lng = getPointValue(point, "lng");
    const altitude = getPointValue(point, "altitude") ?? 0;
    const position = new Vector3();

    WGS84_ELLIPSOID.getCartographicToPosition(
      lat * (Math.PI / 180),
      lng * (Math.PI / 180),
      altitude + altitudeOffset + additionalOffset,
      position
    );

    return position;
  }

  function setAltitudeOffset(value) {
    altitudeOffset = value;

    if (lastResponse) {
      render(lastResponse);
    }
  }

  function setMarkerAltitudeOffset(value) {
    markerAltitudeOffset = value;

    if (lastResponse) {
      render(lastResponse);
    }
  }

  function setMarkerRadius(value) {
    markerRadius = value;

    if (lastResponse) {
      render(lastResponse);
    }
  }

  function getPointValue(point, key) {
    const value = point?.[key];
    if (typeof value === "function") {
      return value.call(point);
    }
    return value;
  }

  function getRouteSegments(route) {
    const segments =
      route.legs?.flatMap((leg) =>
        leg.steps
          ?.filter((step) => Array.isArray(step.path) && step.path.length > 1)
          .map((step) => ({
            path: step.path,
            travelMode: step.travelMode,
          })) || []
      ) || [];

    if (segments.length > 0) {
      return segments;
    }

    return [
      {
        path: route.path,
        travelMode: "DRIVING",
      },
    ];
  }

  function updateCarTransform() {
    const state = animationState;
    if (!state || !carMesh || primaryRouteMarkerPoints.length < 2) {
      return;
    }

    let remainingDistance = state.distance;
    let segmentIndex = 0;

    while (
      segmentIndex < state.segmentLengths.length - 1 &&
      remainingDistance > state.segmentLengths[segmentIndex]
    ) {
      remainingDistance -= state.segmentLengths[segmentIndex];
      segmentIndex += 1;
    }

    const start = primaryRouteMarkerPoints[segmentIndex];
    const end =
      primaryRouteMarkerPoints[
        Math.min(segmentIndex + 1, primaryRouteMarkerPoints.length - 1)
      ];
    const segmentLength = Math.max(state.segmentLengths[segmentIndex], 1e-6);
    const alpha = Math.min(remainingDistance / segmentLength, 1);
    const position = start.clone().lerp(end, alpha);

    routeTangent.subVectors(end, start).normalize();
    routeNormal.copy(position).normalize();
    routeBinormal.crossVectors(routeNormal, routeTangent).normalize();
    routeTangent.crossVectors(routeBinormal, routeNormal).normalize();

    routeMatrix.makeBasis(routeTangent, routeBinormal, routeNormal);
    carMesh.position.copy(position);
    carMesh.quaternion.setFromRotationMatrix(routeMatrix);
    firstPersonPose = {
      position: position.clone(),
      forward: routeTangent.clone(),
      up: routeNormal.clone(),
      right: routeBinormal.clone(),
    };
  }

  function toggleAnimation() {
    if (!primaryRouteMarkerPoints.length) {
      console.warn("No primary route available to animate.");
      return;
    }

    if (!animationState) {
      startAnimation();
      return;
    }

    animationState.paused = !animationState.paused;
  }

  function stopAnimation() {
    if (!animationState) {
      if (carMesh) {
        carMesh.visible = false;
      }
      return;
    }

    animationState.distance = 0;
    animationState.paused = true;

    if (carMesh) {
      carMesh.visible = true;
    }

    updateCarTransform();
  }

  return {
    attachToTilesGroup,
    render,
    clear,
    startAnimation,
    toggleAnimation,
    stopAnimation,
    update,
    getFirstPersonPose: () => firstPersonPose,
    setAltitudeOffset,
    setMarkerAltitudeOffset,
    setMarkerRadius,
    setResolution,
  };
}
