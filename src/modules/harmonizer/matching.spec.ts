import {
  asciiFold,
  matchByName,
  normalize,
  parseVariables,
} from './matching.js';

describe('harmonizer: normalize', () => {
  it('minúsculas, acentos fuera, no-alfanumérico a "_", sin "_" en los extremos', () => {
    expect(normalize('Var_Nombre ')).toBe('var_nombre');
    expect(normalize('edad-1')).toBe('edad_1');
    expect(normalize('Año')).toBe('ano');
    expect(normalize('  Ingreso Mensual (MXN) ')).toBe('ingreso_mensual_mxn');
  });

  it('una cadena solo de puntuación queda vacía', () => {
    expect(normalize('---')).toBe('');
    expect(normalize('¿?')).toBe('');
  });
});

describe('harmonizer: matchByName', () => {
  const canonicals = [
    { id: 'c-edad', name: 'edad' },
    { id: 'c-id', name: 'id' },
    { id: 'c-ingreso', name: 'ingreso' },
    { id: 'c-ingreso-anual', name: 'ingreso_anual' },
  ];

  it('coincidencia exacta (tras normalizar)', () => {
    expect(matchByName('Edad', canonicals)).toBe('c-edad');
  });

  it('sufijo numérico permitido pero acotado a token: edad1 -> edad', () => {
    expect(matchByName('edad1', canonicals)).toBe('c-edad');
    expect(matchByName('edad_2020', canonicals)).toBe('c-edad');
  });

  it('la canónica debe ser un token delimitado: identificacion NO matchea id', () => {
    expect(matchByName('identificacion', canonicals)).toBeNull();
    expect(matchByName('id_hogar', canonicals)).toBe('c-id');
  });

  it('con igual puntuación gana la canónica de nombre más largo (más específica)', () => {
    expect(matchByName('ingreso_anual_2020', canonicals)).toBe(
      'c-ingreso-anual',
    );
  });

  it('la coincidencia exacta gana a la de token aunque la de token sea más larga', () => {
    expect(matchByName('ingreso', canonicals)).toBe('c-ingreso');
  });

  it('si aún empatan gana el id mayor, no el orden de aparición', () => {
    const tie = [
      { id: 'a', name: 'sexo' },
      { id: 'b', name: 'Sexo' },
    ];
    expect(matchByName('sexo1', tie)).toBe('b');
    expect(matchByName('sexo1', [...tie].reverse())).toBe('b');
  });

  it('columna o canónica vacías tras normalizar se descartan', () => {
    expect(matchByName('---', canonicals)).toBeNull();
    expect(matchByName('edad', [{ id: 'x', name: '??' }])).toBeNull();
  });

  it('sin coincidencia devuelve null', () => {
    expect(matchByName('folio', canonicals)).toBeNull();
  });
});

describe('harmonizer: parseVariables', () => {
  it('acepta valores repetidos, recortando y deduplicando en orden', () => {
    expect(parseVariables('edad')).toEqual(['edad']);
    expect(parseVariables(['edad', 'sexo'])).toEqual(['edad', 'sexo']);
    expect(parseVariables([' edad ', 'edad', ' ', 'ingreso'])).toEqual(['edad', 'ingreso']);
  });

  it('no parte por comas: un nombre canónico puede contenerlas (H-13)', () => {
    expect(parseVariables('municipio, clave')).toEqual(['municipio, clave']);
    expect(parseVariables(['municipio, clave', 'edad'])).toEqual(['municipio, clave', 'edad']);
  });

  it('undefined o vacío -> []', () => {
    expect(parseVariables(undefined)).toEqual([]);
    expect(parseVariables('')).toEqual([]);
  });
});

describe('harmonizer: asciiFold', () => {
  it('pliega a ASCII para Content-Disposition', () => {
    expect(asciiFold('Socioeconómica')).toBe('Socioeconomica');
    expect(asciiFold('Alimentación ñ')).toBe('Alimentacion n');
  });
});
