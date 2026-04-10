import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { issuesApi } from "./issues";

describe("issuesApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("passes parentId through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { parentId: "issue-parent-1", limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?parentId=issue-parent-1&limit=25",
    );
  });

  it("calls the deliverables endpoint for an issue", async () => {
    await issuesApi.getDeliverables("issue-1");

    expect(mockApi.get).toHaveBeenCalledWith("/issues/issue-1/deliverables");
  });

  it("calls the company work products endpoint with filters", async () => {
    await issuesApi.listCompanyWorkProducts("company-1", { type: "artifact", limit: 24 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/work-products?type=artifact&limit=24",
    );
  });

  it("calls the company deliverables endpoint", async () => {
    await issuesApi.listCompanyDeliverables("company-1");

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/deliverables");
  });
});
