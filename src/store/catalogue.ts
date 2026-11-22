import type { Config } from "./config";
import type { Product } from "./products";

/**
 * Which products and areas exist. Built from product files (groundwork/products/), or, for a project that hasn't
 * run `groundwork migrate`, from the flat productAreas / products lists in config.yml ("legacy").
 */

export interface CatalogueArea {
  id: string;
  label: string;
  /** The product that defines the area. Unset for legacy areas. */
  productId?: string;
}

export interface Catalogue {
  /** True for a project still using config.yml's flat lists. */
  legacy: boolean;
  /** Product files. Empty for legacy projects. */
  products: Product[];
  areas: CatalogueArea[];
  /** Product titles, or the legacy names. */
  productNames: string[];
}

export function catalogueOf(config: Config, products: Product[]): Catalogue {
  if (products.length) {
    return {
      legacy: false,
      products,
      areas: products.flatMap((p) => p.areas.map((a) => ({ id: a.id, label: a.label, productId: p.id }))),
      productNames: products.map((p) => p.title),
    };
  }
  return {
    legacy: config.productAreas.length > 0 || config.products.length > 0,
    products: [],
    areas: config.productAreas.map((a) => ({ id: a.id, label: a.label })),
    productNames: config.products,
  };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function findArea(c: Catalogue, value: string): CatalogueArea | undefined {
  return c.areas.find((a) => a.id === value) ?? c.areas.find((a) => same(a.label, value));
}

export function findProduct(c: Catalogue, value: string): Product | undefined {
  return c.products.find((p) => p.id === value) ?? c.products.find((p) => same(p.title, value));
}
