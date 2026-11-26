/**
 * Pure helpers deriving Home Assistant floors and areas from the ETS building
 * structure of an imported project, for entities created from suggestions.
 */

import type { SupportedPlatform } from "../types/entity_data";
import type { EntitySuggestion, KNXProject, KNXSpace } from "../types/websocket";

// ETS space types becoming a Home Assistant floor
const FLOOR_SPACE_TYPES = new Set(["Floor"]);
// ETS space types becoming a Home Assistant area - spaces of other types (eg.
// a segment of a room) take the area of a space containing them
const AREA_SPACE_TYPES = new Set(["Room", "Corridor", "Stairway"]);
// devices placed in a distribution board - even one within a room - are actuators
// or system devices: the room of the board says nothing about what they control
const DISTRIBUTION_BOARD_SPACE_TYPES = new Set(["DistributionBoard"]);

// a zero padded sort number like "05. " in "05. Kitchen" - a single digit like
// in "1. OG" (first floor) is part of the name
const SORT_NUMBER_PATTERN = /^\d{2,}\.\s+(?=\S)/;

export interface ProjectFloor {
  name: string;
  // position in the ETS building structure
  order: number;
}

export interface ProjectArea {
  name: string;
  floor: ProjectFloor | null;
}

export interface ProjectAreas {
  // key: space identifier - every space within an area-like space, the area itself included
  areaBySpace: Record<string, ProjectArea>;
  // key: individual address - devices placed in a room, not in a distribution board
  areaByDevice: Record<string, ProjectArea>;
  // key: group address - the areas of the ETS functions using it
  areasByGroupAddress: Record<string, ProjectArea[]>;
}

export interface ProjectAreaOptions {
  // remove sort numbers like "05. " from the names of floors and areas
  stripSortNumbers?: boolean;
}

export const stripSortNumber = (name: string): string => name.replace(SORT_NUMBER_PATTERN, "");

/** Floors and areas of the ETS building structure - by space, by device and by group address. */
export const getProjectAreas = (
  project: Pick<KNXProject, "locations"> & { functions?: KNXProject["functions"] },
  options: ProjectAreaOptions = {},
): ProjectAreas => {
  const areaBySpace: Record<string, ProjectArea> = {};
  const areaByDevice: Record<string, ProjectArea> = {};
  const areaSpaces: ProjectArea[] = [];
  const spaceName = (space: KNXSpace) =>
    options.stripSortNumbers ? stripSortNumber(space.name) : space.name;
  let floorCount = 0;

  const walk = (
    spaces: Record<string, KNXSpace>,
    floor: ProjectFloor | null,
    area: ProjectArea | null,
    inDistributionBoard: boolean,
  ) => {
    Object.values(spaces).forEach((space) => {
      let spaceFloor = floor;
      let spaceArea = area;
      if (!area && FLOOR_SPACE_TYPES.has(space.type)) {
        spaceFloor = { name: spaceName(space), order: floorCount++ };
      } else if (!area && AREA_SPACE_TYPES.has(space.type)) {
        spaceArea = { name: spaceName(space), floor };
        areaSpaces.push(spaceArea);
      }
      const spaceInDistributionBoard =
        inDistributionBoard || DISTRIBUTION_BOARD_SPACE_TYPES.has(space.type);
      if (spaceArea) {
        areaBySpace[space.identifier] = spaceArea;
      }
      space.devices.forEach((ia) => {
        // innermost space listing the device wins
        if (spaceArea && !spaceInDistributionBoard) {
          areaByDevice[ia] = spaceArea;
        } else {
          delete areaByDevice[ia];
        }
      });
      walk(space.spaces, spaceFloor, spaceArea, spaceInDistributionBoard);
    });
  };
  walk(project.locations ?? {}, null, null, false);
  disambiguateAreaNames(areaSpaces);

  const areasByGroupAddress: Record<string, ProjectArea[]> = {};
  Object.values(project.functions ?? {}).forEach((func) => {
    const area = areaBySpace[func.space_id];
    if (!area) return;
    Object.values(func.group_addresses).forEach(({ address }) => {
      const areas = (areasByGroupAddress[address] ??= []);
      if (!areas.includes(area)) areas.push(area);
    });
  });

  return { areaBySpace, areaByDevice, areasByGroupAddress };
};

/**
 * Area names are unique in Home Assistant - rooms of the same name (eg. "Corridor")
 * would otherwise end up in the same area. Those on different floors are prefixed
 * with their floor, those still sharing a name get a number.
 */
const disambiguateAreaNames = (areas: ProjectArea[]) => {
  const countNames = () => {
    const counts = new Map<string, number>();
    areas.forEach((area) => {
      const key = normalizeRegistryName(area.name);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  };
  const nameCounts = countNames();
  areas.forEach((area) => {
    if (area.floor && nameCounts.get(normalizeRegistryName(area.name))! > 1) {
      area.name = `${area.floor.name} ${area.name}`;
    }
  });
  const remainingCounts = countNames();
  const seen = new Map<string, number>();
  areas.forEach((area) => {
    const key = normalizeRegistryName(area.name);
    if (remainingCounts.get(key)! < 2) return;
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    if (index > 1) area.name = `${area.name} ${index}`;
  });
};

/** Write and state group addresses of a `knx` config, in the order of its keys - no passive ones. */
const groupAddressesOfConfig = (config: unknown): string[] => {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const record = config as Record<string, unknown>;
  if ("write" in record || "state" in record) {
    return [record.write, record.state].filter(
      (address): address is string => typeof address === "string" && !!address,
    );
  }
  return Object.values(record).flatMap(groupAddressesOfConfig);
};

/**
 * The area an entity created from a suggestion belongs to.
 * `fn` suggestions are grouped by the space of their function. Others are grouped
 * by the individual address of their device - an actuator in a distribution board
 * mostly - so the room of an ETS function using its group addresses is preferred:
 * the first write or state address used by functions of a single area decides.
 * Only then the room the device is placed in is used.
 */
export const suggestionArea = (
  suggestion: EntitySuggestion,
  platform: SupportedPlatform,
  projectAreas: ProjectAreas,
): ProjectArea | undefined => {
  if (suggestion.source === "fn") {
    return projectAreas.areaBySpace[suggestion.group_id];
  }
  const addresses = groupAddressesOfConfig(suggestion.suggestions[platform]?.knx);
  for (const address of addresses) {
    const areas = projectAreas.areasByGroupAddress[address];
    if (areas?.length === 1) return areas[0];
  }
  return projectAreas.areaByDevice[suggestion.group_id];
};

/**
 * Names of floors and areas are compared like Home Assistant does to keep them
 * unique - `name.casefold().replace(" ", "")` of its registries. Upper casing
 * first applies the case folding of eg. "ß" to "ss" that lower casing lacks.
 */
export const normalizeRegistryName = (name: string): string =>
  name.toUpperCase().toLowerCase().replace(/ /g, "");

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
