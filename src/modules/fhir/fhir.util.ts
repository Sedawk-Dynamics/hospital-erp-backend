export const buildBundle = (resources: any[]) => ({
  resourceType: "Bundle",
  type: "searchset",
  total: resources.length,
  entry: resources.map((resource) => ({ resource })),
});
