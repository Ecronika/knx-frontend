import { describe, expect, it } from "vitest";
import type { EntitySuggestion, KNXSpace } from "../types/websocket";
import {
  findRegistryIdByName,
  getProjectAreas,
  normalizeRegistryName,
  suggestionArea,
} from "./project-areas";

const space = (identifier: string, overrides: Partial<KNXSpace> = {}): KNXSpace => ({
  type: "Room",
  identifier,
  name: identifier,
  usage_id: null,
  usage_text: "",
  number: "",
  description: "",
  project_uid: null,
  devices: [],
  spaces: {},
  functions: [],
  ...overrides,
});

const suggestion = (source: string, groupId: string): EntitySuggestion => ({
  id: `${source}-${groupId}`,
  source,
  suggested_name: "",
  group_id: groupId,
  group_name: "",
  secondary_info: "",
  platform_options: [],
  suggestions: {},
  existing_entity_ids: [],
  metadata: {},
});

/**
 * Building
 * ├─ Ground floor (Floor)
 * │  ├─ Kitchen (Room)          devices 1.1.1
 * │  │  └─ Segment (RoomSegment) devices 1.1.2
 * │  ├─ Corridor (Corridor)
 * │  └─ Board (DistributionBoard) devices 1.1.3
 * └─ First floor (Floor)
 *    └─ Corridor (Corridor)
 * Garden (Room - not on a floor)
 */
const locations: Record<string, KNXSpace> = {
  building: space("building", {
    type: "Building",
    name: "Building",
    devices: ["1.1.9"],
    spaces: {
      gf: space("gf", {
        type: "Floor",
        name: "Ground floor",
        spaces: {
          kitchen: space("kitchen", {
            name: "Kitchen",
            devices: ["1.1.1"],
            spaces: {
              segment: space("segment", { type: "RoomSegment", devices: ["1.1.2"] }),
            },
          }),
          gfCorridor: space("gfCorridor", { type: "Corridor", name: "Corridor" }),
          board: space("board", { type: "DistributionBoard", devices: ["1.1.3"] }),
        },
      }),
      ff: space("ff", {
        type: "Floor",
        name: "First floor",
        spaces: {
          ffCorridor: space("ffCorridor", { type: "Corridor", name: " corridor" }),
        },
      }),
    },
  }),
  garden: space("garden", { name: "Garden" }),
};

describe("getProjectAreas", () => {
  const { areaBySpace, spaceByDevice } = getProjectAreas(locations);

  it("maps rooms to areas on their floor", () => {
    expect(areaBySpace.kitchen).toEqual({ name: "Kitchen", floor: { name: "Ground floor" } });
    expect(areaBySpace.garden).toEqual({ name: "Garden", floor: null });
  });

  it("gives spaces within a room the area of the room", () => {
    expect(areaBySpace.segment).toBe(areaBySpace.kitchen);
  });

  it("gives no area to spaces not within a room", () => {
    expect(areaBySpace.building).toBeUndefined();
    expect(areaBySpace.gf).toBeUndefined();
    expect(areaBySpace.board).toBeUndefined();
  });

  it("prefixes areas of the same name with their floor", () => {
    expect(areaBySpace.gfCorridor.name).toBe("Ground floor Corridor");
    expect(areaBySpace.ffCorridor.name).toBe("First floor  corridor");
    expect(areaBySpace.kitchen.name).toBe("Kitchen");
  });

  it("places a device in the innermost space listing it", () => {
    expect(spaceByDevice).toEqual({
      "1.1.9": "building",
      "1.1.1": "kitchen",
      "1.1.2": "segment",
      "1.1.3": "board",
    });
  });

  it("returns nothing without a building structure", () => {
    expect(getProjectAreas(null)).toEqual({ areaBySpace: {}, spaceByDevice: {} });
  });
});

describe("suggestionArea", () => {
  const projectAreas = getProjectAreas(locations);

  it("uses the space of a building function", () => {
    expect(suggestionArea(suggestion("fn", "kitchen"), projectAreas)?.name).toBe("Kitchen");
  });

  it("uses the space of the device of other suggestions", () => {
    expect(suggestionArea(suggestion("fb", "1.1.2"), projectAreas)?.name).toBe("Kitchen");
    expect(suggestionArea(suggestion("cfg", "1.1.1"), projectAreas)?.name).toBe("Kitchen");
  });

  it("has no area for devices not placed in a room", () => {
    expect(suggestionArea(suggestion("fb", "1.1.3"), projectAreas)).toBeUndefined();
    expect(suggestionArea(suggestion("fb", "1.1.99"), projectAreas)).toBeUndefined();
    expect(suggestionArea(suggestion("fn", "unknown"), projectAreas)).toBeUndefined();
  });
});

describe("registry names", () => {
  it("compares case and whitespace insensitive", () => {
    expect(normalizeRegistryName(" Living  Room")).toBe(normalizeRegistryName("living room"));
    expect(
      findRegistryIdByName({ a: { name: "Kitchen" }, b: { name: "Living room" } }, "living Room"),
    ).toBe("b");
    expect(findRegistryIdByName({ a: { name: "Kitchen" } }, "Bath")).toBeUndefined();
  });
});
