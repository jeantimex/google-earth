import { WGS84_ELLIPSOID } from "3d-tiles-renderer";
import {
  Box3,
  CircleGeometry,
  Color,
  Group,
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
  const zAxis = new Vector3(0, 0, 1);
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

  return {
    attachToTilesGroup,
    render,
    clear,
    setAltitudeOffset,
    setMarkerAltitudeOffset,
    setMarkerRadius,
    setResolution,
  };
}
