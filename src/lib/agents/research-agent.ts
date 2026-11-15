/**
 * Research Agent
 * 
 * Queries carbon footprint databases to get environmental impact data.
 * Uses mock data initially, can integrate Open Food Facts API later.
 */

export interface ResearchResult {
  carbon_footprint_kg: number;
  recyclability_score: number;
  material_breakdown: { material: string; percentage: number; carbon_intensity: number }[];
  water_usage_liters: number;
  energy_consumption_mj: number;
}

// Mock carbon database for common materials
const CARBON_DATABASE: Record<string, { 
  carbon_per_kg: number; 
  recyclability: number;
  water_per_kg: number;
  energy_per_kg: number;
}> = {
  'PET plastic': { carbon_per_kg: 2.8, recyclability: 85, water_per_kg: 50, energy_per_kg: 80 },
  'HDPE plastic': { carbon_per_kg: 1.8, recyclability: 90, water_per_kg: 40, energy_per_kg: 60 },
  'glass': { carbon_per_kg: 0.85, recyclability: 95, water_per_kg: 25, energy_per_kg: 15 },
  'aluminum': { carbon_per_kg: 11.0, recyclability: 95, water_per_kg: 115, energy_per_kg: 170 },
  'steel': { carbon_per_kg: 1.9, recyclability: 90, water_per_kg: 45, energy_per_kg: 55 },
  'paper': { carbon_per_kg: 0.9, recyclability: 95, water_per_kg: 30, energy_per_kg: 35 },
  'cardboard': { carbon_per_kg: 0.5, recyclability: 95, water_per_kg: 20, energy_per_kg: 20 },
  'mixed plastic': { carbon_per_kg: 2.5, recyclability: 40, water_per_kg: 60, energy_per_kg: 75 },
  'bioplastic': { carbon_per_kg: 1.5, recyclability: 30, water_per_kg: 80, energy_per_kg: 50 },
  'tetra pak': { carbon_per_kg: 1.2, recyclability: 60, water_per_kg: 35, energy_per_kg: 40 },
};

// Estimate packaging weight based on type
function estimateWeight(packagingType: string): number {
  const weights: Record<string, number> = {
    'bottle': 0.05,
    'box': 0.1,
    'bag': 0.02,
    'jar': 0.08,
    'can': 0.03,
    'wrapper': 0.01,
    'container': 0.06,
    'carton': 0.08,
  };
  
  return weights[packagingType.toLowerCase()] || 0.05;
}

export async function runResearchAgent(
  detectedMaterials: string[],
  packagingType: string
): Promise<{ result: ResearchResult | null; error: Error | null }> {
  try {
    const estimatedWeight = estimateWeight(packagingType);
    
    // Calculate material breakdown. The shares must sum to 100:
    // Math.round(100 / n) each gave 33/33/33 = 99 for three
    // materials. Floor shares, and give the remainder to the first.
    const shareBase = Math.floor(100 / detectedMaterials.length);
    const shareRemainder = 100 - shareBase * detectedMaterials.length;
    const materialBreakdown = detectedMaterials.map((material, index) => {
      const normalizedMaterial = material.toLowerCase();
      let matchedData = CARBON_DATABASE['mixed plastic']; // default
      
      // Find matching material in database
      for (const [key, data] of Object.entries(CARBON_DATABASE)) {
        if (normalizedMaterial.includes(key.toLowerCase())) {
          matchedData = data;
          break;
        }
      }
      
      // Estimate percentage (equal distribution for simplicity)
      const percentage = shareBase + (index === 0 ? shareRemainder : 0);
      const weight = estimatedWeight * (percentage / 100);
      
      return {
        material,
        percentage,
        carbon_intensity: matchedData.carbon_per_kg,
        carbon_footprint: weight * matchedData.carbon_per_kg,
        water_usage: weight * matchedData.water_per_kg,
        energy_consumption: weight * matchedData.energy_per_kg,
      };
    });

    // Calculate totals
    const carbonFootprint = materialBreakdown.reduce((sum, m) => sum + m.carbon_footprint, 0);
    const waterUsage = materialBreakdown.reduce((sum, m) => sum + m.water_usage, 0);
    const energyConsumption = materialBreakdown.reduce((sum, m) => sum + m.energy_consumption, 0);
    
    // Calculate weighted recyclability score
    const recyclabilityScore = Math.round(
      materialBreakdown.reduce((sum, m) => {
        const materialData = Object.entries(CARBON_DATABASE).find(([key]) => 
          m.material.toLowerCase().includes(key.toLowerCase())
        );
        const recyclability = materialData ? materialData[1].recyclability : 50;
        return sum + (recyclability * m.percentage / 100);
      }, 0)
    );

    const result: ResearchResult = {
      carbon_footprint_kg: Math.round(carbonFootprint * 1000) / 1000,
      recyclability_score: Math.min(100, Math.max(0, recyclabilityScore)),
      material_breakdown: materialBreakdown.map(m => ({
        material: m.material,
        percentage: m.percentage,
        carbon_intensity: m.carbon_intensity,
      })),
      water_usage_liters: Math.round(waterUsage * 10) / 10,
      energy_consumption_mj: Math.round(energyConsumption * 10) / 10,
    };

    return { result, error: null };
  } catch (error) {
    console.error('Research Agent error:', error);
    return { result: null, error: error as Error };
  }
}
