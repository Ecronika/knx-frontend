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
// ETS space types becoming a Home Assistant area without a floor if functions are
// placed directly in them - like a building part "Outside" with a carport and a garden
const FUNCTION_AREA_SPACE_TYPES = new Set(["Building", "BuildingPart", "Floor"]);
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
  // key: space identifier - every space within an area-like space, the area itself included,
  // and spaces outside of a room holding functions directly
  areaBySpace: Record<string, ProjectArea>;
  // key: individual address - devices placed in a room, not in a distribution board
  areaByDevice: Record<string, ProjectArea>;
  // key: group address - the areas of the ETS functions using it
  areasByGroupAddress: Record<string, ProjectArea[]>;
  // areas of spaces outside of a room holding functions - a room is preferred over them
  outsideRoomAreas: ReadonlySet<ProjectArea>;
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
  const outsideRoomAreas = new Set<ProjectArea>();
  const spaceName = (space: KNXSpace) =>
    options.stripSortNumbers ? stripSortNumber(space.name) : space.name;
  let floorCount = 0;
  const functionSpaceIds = new Set(
    Object.values(project.functions ?? {}).map((func) => func.space_id),
  );

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
      } else if (
        FUNCTION_AREA_SPACE_TYPES.has(space.type) &&
        (space.functions.length || functionSpaceIds.has(space.identifier))
      ) {
        // only for the functions placed here - not for the rooms within or devices placed here
        const functionArea = { name: spaceName(space), floor: null };
        areaBySpace[space.identifier] = functionArea;
        areaSpaces.push(functionArea);
        outsideRoomAreas.add(functionArea);
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

  return { areaBySpace, areaByDevice, areasByGroupAddress, outsideRoomAreas };
};

/**
 * Area names are unique in Home Assistant - rooms of the same name (eg. "Corridor")
 * would otherwise end up in the same area. If rooms sharing a name are on different
 * floors, those on a floor are prefixed with it - a prefix telling nothing apart is
 * left out. Rooms still sharing a name, eg. on the same floor, get a number.
 */
const disambiguateAreaNames = (areas: ProjectArea[]) => {
  const byName = () => {
    const groups = new Map<string, ProjectArea[]>();
    areas.forEach((area) => {
      const key = normalizeRegistryName(area.name);
      groups.set(key, [...(groups.get(key) ?? []), area]);
    });
    return groups;
  };
  byName().forEach((group) => {
    if (new Set(group.map((area) => area.floor)).size < 2) return;
    group.forEach((area) => {
      if (area.floor) area.name = `${area.floor.name} ${area.name}`;
    });
  });
  byName().forEach((group) => {
    group.forEach((area, index) => {
      if (index > 0) area.name = `${area.name} ${index + 1}`;
    });
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
 * the first write or state address used by functions of a single room decides - or
 * else of a single space outside of a room, eg. a central function of the building.
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
  for (const outsideRoom of [false, true]) {
    for (const address of addresses) {
      const areas = (projectAreas.areasByGroupAddress[address] ?? []).filter(
        (area) => projectAreas.outsideRoomAreas.has(area) === outsideRoom,
      );
      if (areas.length === 1) return areas[0];
    }
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
