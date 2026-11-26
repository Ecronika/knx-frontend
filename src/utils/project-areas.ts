/**
 * Pure helpers deriving Home Assistant floors and areas from the ETS building
 * structure of an imported project, for entities created from suggestions.
 */

import type { EntitySuggestion, KNXSpace } from "../types/websocket";

// ETS space types becoming a Home Assistant floor
const FLOOR_SPACE_TYPES = new Set(["Floor"]);
// ETS space types becoming a Home Assistant area - spaces of other types (eg.
// a distribution board or a segment of a room) take the area of a space containing them
const AREA_SPACE_TYPES = new Set(["Room", "Corridor", "Stairway"]);

export interface ProjectFloor {
  name: string;
}

export interface ProjectArea {
  name: string;
  floor: ProjectFloor | null;
}

export interface ProjectAreas {
  // key: space identifier - every space within an area-like space, the area itself included
  areaBySpace: Record<string, ProjectArea>;
  // key: individual address - the innermost space listing the device
  spaceByDevice: Record<string, string>;
}

/** Floors and areas of the ETS building structure, by space and by device placed in it. */
export const getProjectAreas = (locations: Record<string, KNXSpace> | null): ProjectAreas => {
  const areaBySpace: Record<string, ProjectArea> = {};
  const spaceByDevice: Record<string, string> = {};
  const areaSpaces: { space: KNXSpace; area: ProjectArea }[] = [];

  const walk = (
    spaces: Record<string, KNXSpace>,
    floor: ProjectFloor | null,
    area: ProjectArea | null,
  ) => {
    Object.values(spaces).forEach((space) => {
      let spaceFloor = floor;
      let spaceArea = area;
      if (!area && FLOOR_SPACE_TYPES.has(space.type)) {
        spaceFloor = { name: space.name };
      } else if (!area && AREA_SPACE_TYPES.has(space.type)) {
        spaceArea = { name: space.name, floor };
        areaSpaces.push({ space, area: spaceArea });
      }
      if (spaceArea) {
        areaBySpace[space.identifier] = spaceArea;
      }
      space.devices.forEach((ia) => {
        // innermost space listing the device wins
        spaceByDevice[ia] = space.identifier;
      });
      walk(space.spaces, spaceFloor, spaceArea);
    });
  };
  if (locations) {
    walk(locations, null, null);
  }

  // area names are unique in Home Assistant - rooms of the same name on
  // different floors (eg. "Corridor") would otherwise end up in the same area
  const nameCounts = new Map<string, number>();
  areaSpaces.forEach(({ area }) => {
    const key = normalizeRegistryName(area.name);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  });
  areaSpaces.forEach(({ area }) => {
    if (area.floor && nameCounts.get(normalizeRegistryName(area.name))! > 1) {
      area.name = `${area.floor.name} ${area.name}`;
    }
  });

  return { areaBySpace, spaceByDevice };
};

/**
 * The area an entity created from a suggestion belongs to - `fn` suggestions are
 * grouped by the space of their function, `fb` and `cfg` suggestions by the
 * individual address of their device which is placed in a space.
 */
export const suggestionArea = (
  suggestion: EntitySuggestion,
  projectAreas: ProjectAreas,
): ProjectArea | undefined => {
  const spaceId =
    suggestion.source === "fn"
      ? suggestion.group_id
      : projectAreas.spaceByDevice[suggestion.group_id];
  return spaceId ? projectAreas.areaBySpace[spaceId] : undefined;
};

/**
 * Names of floors and areas are compared like Home Assistant does to keep them
 * unique - ignoring case and spaces (`normalize_name` of its registries).
 */
export const normalizeRegistryName = (name: string): string => name.toLowerCase().replace(/ /g, "");

/** The id of the registry entry of the given name, if there is one. */
export const findRegistryIdByName = (
  entries: Record<string, { name: string }>,
  name: string,
): string | undefined => {
  const normalized = normalizeRegistryName(name);
  return Object.entries(entries).find(
    ([_, entry]) => normalizeRegistryName(entry.name) === normalized,
  )?.[0];
};
