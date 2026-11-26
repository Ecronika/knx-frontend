import { describe, expect, it } from "vitest";
import type { EntitySuggestion, KNXFunction, KNXSpace } from "../types/websocket";
import {
  findRegistryIdByName,
  getProjectAreas,
  normalizeRegistryName,
  stripSortNumber,
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

const func = (identifier: string, spaceId: string, addresses: string[]): KNXFunction => ({
  function_type: "FT-1",
  group_addresses: Object.fromEntries(
    addresses.map((address) => [
      `ref-${address}`,
      { address, name: "", project_uid: null, role: "SwitchOnOff" },
    ]),
  ),
  identifier,
  name: identifier,
  project_uid: null,
  space_id: spaceId,
  usage_text: "",
});

const suggestion = (
  source: string,
  groupId: string,
  knx: Record<string, unknown> = {},
): EntitySuggestion => ({
  id: `${source}-${groupId}`,
  source,
  suggested_name: "",
  group_id: groupId,
  group_name: "",
  secondary_info: "",
  platform_options: ["switch"],
  suggestions: { switch: { knx, matched_group_addresses: [], unmatched: [] } },
  existing_entity_ids: [],
  metadata: {},
});

/**
 * Building
 * ├─ 00. Ground floor (Floor)
 * │  ├─ 05. Kitchen (Room)              devices 1.1.1
 * │  │  └─ Segment (RoomSegment)         devices 1.1.2
 * │  ├─ Corridor (Corridor)
 * │  ├─ Corridor (Corridor)              - same name on the same floor
 * │  ├─ Board (DistributionBoard)        devices 1.1.3
 * │  └─ Technical room (Room)            devices 1.1.4
 * │     └─ Room board (DistributionBoard) devices 1.1.5
 * └─ 1. First floor (Floor)
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
        name: "00. Ground floor",
        spaces: {
          kitchen: space("kitchen", {
            name: "05. Kitchen",
            devices: ["1.1.1"],
            spaces: {
              segment: space("segment", { type: "RoomSegment", devices: ["1.1.2"] }),
            },
          }),
          gfCorridor: space("gfCorridor", { type: "Corridor", name: "Corridor" }),
          gfCorridor2: space("gfCorridor2", { type: "Corridor", name: "Corridor" }),
          board: space("board", { type: "DistributionBoard", devices: ["1.1.3"] }),
          technical: space("technical", {
            name: "Technical room",
            devices: ["1.1.4"],
            spaces: {
              roomBoard: space("roomBoard", { type: "DistributionBoard", devices: ["1.1.5"] }),
            },
          }),
        },
      }),
      ff: space("ff", {
        type: "Floor",
        name: "1. First floor",
        spaces: {
          ffCorridor: space("ffCorridor", { type: "Corridor", name: " corridor" }),
        },
      }),
    },
  }),
  garden: space("garden", { name: "Garden" }),
};

const functions: Record<string, KNXFunction> = {
  kitchenLight: func("kitchenLight", "kitchen", ["1/0/1", "1/0/2", "0/0/1"]),
  gardenLight: func("gardenLight", "garden", ["1/0/3", "0/0/1"]),
  buildingCentral: func("buildingCentral", "building", ["1/0/4"]),
};

describe("getProjectAreas", () => {
  const { areaBySpace, areaByDevice, areasByGroupAddress } = getProjectAreas({
    locations,
    functions,
  });

  it("maps rooms to areas on their floor", () => {
    expect(areaBySpace.kitchen).toEqual({
      name: "05. Kitchen",
      floor: { name: "00. Ground floor", order: 0 },
    });
    expect(areaBySpace.ffCorridor.floor).toEqual({ name: "1. First floor", order: 1 });
    expect(areaBySpace.garden).toEqual({ name: "Garden", floor: null });
  });

  it("gives spaces within a room the area of the room", () => {
    expect(areaBySpace.segment).toBe(areaBySpace.kitchen);
    expect(areaBySpace.roomBoard).toBe(areaBySpace.technical);
  });

  it("gives no area to spaces not within a room", () => {
    expect(areaBySpace.building).toBeUndefined();
    expect(areaBySpace.gf).toBeUndefined();
    expect(areaBySpace.board).toBeUndefined();
  });

  it("makes the names of areas unique", () => {
    expect(areaBySpace.gfCorridor.name).toBe("00. Ground floor Corridor");
    expect(areaBySpace.gfCorridor2.name).toBe("00. Ground floor Corridor 2");
    expect(areaBySpace.ffCorridor.name).toBe("1. First floor  corridor");
    expect(areaBySpace.kitchen.name).toBe("05. Kitchen");
  });

  it("gives devices in a room its area - not those in a distribution board", () => {
    expect(areaByDevice).toEqual({
      "1.1.1": areaBySpace.kitchen,
      "1.1.2": areaBySpace.kitchen,
      "1.1.4": areaBySpace.technical,
    });
  });

  it("lists the areas of the functions using a group address", () => {
    expect(areasByGroupAddress["1/0/1"]).toEqual([areaBySpace.kitchen]);
    expect(areasByGroupAddress["0/0/1"]).toEqual([areaBySpace.kitchen, areaBySpace.garden]);
    // a function of the building has no area
    expect(areasByGroupAddress["1/0/4"]).toBeUndefined();
  });

  it("removes sort numbers if asked to", () => {
    const stripped = getProjectAreas({ locations }, { stripSortNumbers: true }).areaBySpace;
    expect(stripped.kitchen).toEqual({
      name: "Kitchen",
      floor: { name: "Ground floor", order: 0 },
    });
    // a single digit is part of the name
    expect(stripped.ffCorridor.floor!.name).toBe("1. First floor");
    expect(stripped.gfCorridor.name).toBe("Ground floor Corridor");
  });

  it("returns nothing without a building structure", () => {
    expect(getProjectAreas({})).toEqual({
      areaBySpace: {},
      areaByDevice: {},
      areasByGroupAddress: {},
    });
  });
});

describe("suggestionArea", () => {
  const projectAreas = getProjectAreas({ locations, functions });
  const area = (item: EntitySuggestion) => suggestionArea(item, "switch", projectAreas)?.name;

  it("uses the space of a building function", () => {
    expect(area(suggestion("fn", "kitchen"))).toBe("05. Kitchen");
    expect(area(suggestion("fn", "unknown"))).toBeUndefined();
  });

  it("prefers the room of a function using a group address of the channel", () => {
    // actuator in a distribution board switching the garden light
    const knx = { ga_switch: { write: "1/0/3", state: "1/0/9", passive: ["1/0/1"] } };
    expect(area(suggestion("cfg", "1.1.3", knx))).toBe("Garden");
    expect(area(suggestion("fb", "1.1.5", knx))).toBe("Garden");
    // over the room the device is placed in
    expect(area(suggestion("cfg", "1.1.4", knx))).toBe("Garden");
  });

  it("finds group addresses in nested config and skips ambiguous ones", () => {
    const knx = {
      sync_state: true,
      color: { ga_red: { write: "0/0/1" } },
      ga_switch: { state: "1/0/2" },
    };
    expect(area(suggestion("cfg", "1.1.3", knx))).toBe("05. Kitchen");
  });

  it("ignores passive group addresses", () => {
    const knx = { ga_switch: { write: "9/9/9", passive: ["1/0/1"] } };
    expect(area(suggestion("cfg", "1.1.3", knx))).toBeUndefined();
  });

  it("falls back to the room the device is placed in", () => {
    expect(area(suggestion("fb", "1.1.2"))).toBe("05. Kitchen");
    expect(area(suggestion("cfg", "1.1.4"))).toBe("Technical room");
  });

  it("has no area for devices in a distribution board or not placed at all", () => {
    expect(area(suggestion("fb", "1.1.3"))).toBeUndefined();
    expect(area(suggestion("fb", "1.1.5"))).toBeUndefined();
    expect(area(suggestion("fb", "1.1.9"))).toBeUndefined();
    expect(area(suggestion("fb", "1.1.99"))).toBeUndefined();
  });
});

describe("names", () => {
  it("strips zero padded sort numbers only", () => {
    expect(stripSortNumber("04. 2. OG")).toBe("2. OG");
    expect(stripSortNumber("10. Technik (Elektro)")).toBe("Technik (Elektro)");
    expect(stripSortNumber("1. OG")).toBe("1. OG");
    expect(stripSortNumber("05. ")).toBe("05. ");
    expect(stripSortNumber("Küche")).toBe("Küche");
  });

  it("compares registry names like Home Assistant", () => {
    expect(normalizeRegistryName(" Living  Room")).toBe(normalizeRegistryName("living room"));
    expect(normalizeRegistryName("Straße")).toBe(normalizeRegistryName("STRASSE"));
    expect(
      findRegistryIdByName({ a: { name: "Kitchen" }, b: { name: "Living room" } }, "living Room"),
    ).toBe("b");
    expect(findRegistryIdByName({ a: { name: "Kitchen" } }, "Bath")).toBeUndefined();
  });
});
